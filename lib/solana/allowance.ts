import { address, createClient, createSolanaRpc, getBase64Encoder, isAddress, type KeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findFixedDelegationPda, findSubscriptionAuthorityPda, getFixedDelegationDecoder, subscriptionsProgram } from "@solana/subscriptions";
import { agentSolanaAddress, gateSigner, ownerSigner, sellerSolanaAddress, solanaMint, solanaRpcSubscriptionsUrl, solanaRpcUrl } from "./config";

// A task's budget is a Fixed delegation ("Allowance") in the Solana Subscriptions program
// (De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44). The owner is the delegator, the gate's key
// is the delegatee, `amount` is the remaining allowance and `expiry_ts` the task deadline.
// Interlock keeps no budget state of its own: every check reads the account from chain.

export interface AllowanceData {
  delegator: string;
  delegatee: string;
  mint: string;
  /** remaining atomic amount the delegatee may still transfer */
  amount: string;
  /** unix seconds; "0" = no expiry */
  expiry_ts: string;
}

/** What one RPC read returned, exactly as it is written to the ledger. */
export interface AllowanceSnapshot {
  address: string;
  slot: string;
  exists: boolean;
  owner_program?: string;
  data_base64?: string;
  decoded?: AllowanceData;
}

export interface AllowanceChain {
  gateAddress(): Promise<string>;
  ownerAddress(): Promise<string>;
  create(p: { delegatee: string; amount: bigint; expiryTs: bigint; nonce: bigint }): Promise<{ address: string; signature: string }>;
  /** Throws if the RPC cannot answer. A closed (revoked) account reads as exists=false. */
  read(allowance: string): Promise<AllowanceSnapshot>;
  revoke(allowance: string): Promise<{ signature: string }>;
  /** Moves `amount` from the owner's token account to the gate's, under the allowance. */
  pull(allowance: string, amount: bigint): Promise<{ signature: string }>;
}

// ---------------------------------------------------------------------------
// Real implementation (devnet / mainnet via SOLANA_RPC_URL)
// ---------------------------------------------------------------------------

// All writes go through the Subscriptions plugin client (`client.subscriptions.instructions.*`),
// as the SDK asks: it fills in what the low-level overlay builders leave to the caller — the
// SubscriptionAuthority's init id for createFixedDelegation (read from chain), Token-2022
// transfer-hook accounts for transferFixed, and the signer as delegator/delegatee/authority.
// `sendTransaction()` plans, simulates, signs, sends and waits for confirmation. A failure
// throws a kit SolanaError whose context carries the program `logs` and whose `cause` is the
// transaction error; callers print it with formatSolanaError() (lib/solana/errors.ts).
function clientFor(rpcUrl: string, as: KeyPairSigner) {
  return createClient()
    .use(signer(as))
    .use(solanaRpc({ rpcUrl, rpcSubscriptionsUrl: solanaRpcSubscriptionsUrl() }))
    .use(subscriptionsProgram());
}

/** A setup problem the owner must fix (missing SOL, missing token account, authority not set up). */
export class SolanaSetupError extends Error {}

export interface SetupReport {
  rpc: string;
  mint: string;
  owner: { address: string; sol_lamports: string; usdc_ata: string; usdc_ata_exists: boolean; usdc_atomic?: string };
  gate: { address: string; sol_lamports: string };
  subscription_authority: { address: string; exists: boolean };
  agent: { address: string };
  seller: { address: string; usdc_ata?: string; usdc_ata_exists?: boolean };
  /** must be fixed before tasks and payments work */
  problems: string[];
  /** works, but probably not what you meant */
  warnings: string[];
}

const NEW_AGENT = "npm run task -- new-address agent --env AGENT_SOLANA_ADDRESS";
const NEW_SELLER = "npm run task -- new-address seller --env SELLER_SOLANA_PAY_TO";

export class SolanaAllowanceChain implements AllowanceChain {
  constructor(private readonly rpcUrl = solanaRpcUrl()) {}

  async gateAddress() {
    return (await gateSigner()).address;
  }
  async ownerAddress() {
    return (await ownerSigner()).address;
  }

  async create(p: { delegatee: string; amount: bigint; expiryTs: bigint; nonce: bigint }) {
    const owner = await ownerSigner();
    const tokenMint = address(solanaMint());
    const [sa] = await findSubscriptionAuthorityPda({ user: owner.address, tokenMint });
    const saInfo = await createSolanaRpc(this.rpcUrl).getAccountInfo(sa, { encoding: "base64" }).send();
    if (!saInfo.value) throw new SolanaSetupError(`the owner's SubscriptionAuthority ${sa} does not exist yet. Run \`npm run task -- init-authority\` first.`);
    const [delegation] = await findFixedDelegationPda({
      subscriptionAuthority: sa,
      delegator: owner.address,
      delegatee: address(p.delegatee),
      nonce: p.nonce,
    });
    // delegator = the client's identity (the owner); the plugin reads the SA's init id itself.
    const { context } = await clientFor(this.rpcUrl, owner)
      .subscriptions.instructions.createFixedDelegation({
        delegatee: address(p.delegatee),
        tokenMint,
        nonce: p.nonce,
        amount: p.amount,
        expiryTs: p.expiryTs,
      })
      .sendTransaction();
    return { address: delegation, signature: context.signature };
  }

  async read(allowance: string): Promise<AllowanceSnapshot> {
    const rpc = createSolanaRpc(this.rpcUrl);
    const { context, value } = await rpc
      .getAccountInfo(address(allowance), { encoding: "base64", commitment: "confirmed" })
      .send();
    return snapshotFromAccount(allowance, context.slot, value ? { owner: value.owner, data_base64: value.data[0] } : null);
  }

  async revoke(allowance: string) {
    // authority = the client's identity (the owner, who is the delegator).
    const { context } = await clientFor(this.rpcUrl, await ownerSigner())
      .subscriptions.instructions.revokeDelegation({ delegationAccount: address(allowance) })
      .sendTransaction();
    return { signature: context.signature };
  }

  async pull(allowance: string, amount: bigint) {
    const gate = await gateSigner();
    const owner = await this.ownerAddress();
    const tokenMint = address(solanaMint());
    const [ownerAta] = await findAssociatedTokenPda({ owner: address(owner), mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [gateAta] = await findAssociatedTokenPda({ owner: gate.address, mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const client = clientFor(this.rpcUrl, gate);
    const createGateAta = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: gate, owner: gate.address, mint: tokenMint });
    // delegatee = the client's identity (the gate); transfer-hook accounts resolved by the plugin.
    const transfer = await client.subscriptions.instructions.transferFixed({
      amount,
      delegationPda: address(allowance),
      delegator: address(owner),
      delegatorAta: ownerAta,
      receiverAta: gateAta,
      tokenMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    // Both in one transaction, so the gate's token account exists before the transfer.
    const { context } = await client.sendTransaction([createGateAta, transfer]);
    return { signature: context.signature };
  }

  /** Everything the owner and gate need before tasks can work, read from chain. */
  async preflight(): Promise<SetupReport> {
    const rpc = createSolanaRpc(this.rpcUrl);
    const owner = await ownerSigner();
    const gate = await gateSigner();
    const tokenMint = address(solanaMint());
    const agent = agentSolanaAddress();
    const seller = sellerSolanaAddress();
    const sellerValid = isAddress(seller);
    const [ownerAta] = await findAssociatedTokenPda({ owner: owner.address, mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [sa] = await findSubscriptionAuthorityPda({ user: owner.address, tokenMint });
    const sellerAta = sellerValid
      ? (await findAssociatedTokenPda({ owner: address(seller), mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]
      : undefined;
    const [ownerSol, gateSol, ataInfo, saInfo, sellerAtaInfo] = await Promise.all([
      rpc.getBalance(owner.address, { commitment: "confirmed" }).send(),
      rpc.getBalance(gate.address, { commitment: "confirmed" }).send(),
      rpc.getAccountInfo(ownerAta, { encoding: "base64", commitment: "confirmed" }).send(),
      rpc.getAccountInfo(sa, { encoding: "base64", commitment: "confirmed" }).send(),
      sellerAta ? rpc.getAccountInfo(sellerAta, { encoding: "base64", commitment: "confirmed" }).send() : Promise.resolve(undefined),
    ]);
    let usdc: string | undefined;
    if (ataInfo.value) usdc = (await rpc.getTokenAccountBalance(ownerAta, { commitment: "confirmed" }).send()).value.amount;
    const problems: string[] = [];
    const warnings: string[] = [];
    if (ownerSol.value === 0n) problems.push(`owner ${owner.address} has no devnet SOL (fees and rent). Airdrop at https://faucet.solana.com`);
    if (gateSol.value === 0n) problems.push(`gate ${gate.address} has no devnet SOL (fees for pulls and x402 payments). Airdrop at https://faucet.solana.com`);
    if (!ataInfo.value) {
      problems.push(
        `owner has no USDC token account for mint ${tokenMint} (expected associated token account ${ownerAta}). ` +
          `Get devnet USDC from https://faucet.circle.com (Solana Devnet) to ${owner.address}, which creates it, or run ` +
          `\`spl-token create-account ${tokenMint} --owner ${owner.address} --url devnet\``,
      );
    } else if (usdc === "0") {
      problems.push(`owner's USDC token account ${ownerAta} holds 0 USDC. Get devnet USDC from https://faucet.circle.com`);
    }

    // The owner CLI and the agent use different tokens; the task API refuses otherwise.
    if (!process.env.OWNER_TOKEN) problems.push("OWNER_TOKEN is not set in .env.local (the task CLI sends it). Set any secret that differs from AGENT_TOKEN");
    else if (process.env.OWNER_TOKEN === process.env.AGENT_TOKEN) problems.push("OWNER_TOKEN equals AGENT_TOKEN; the task API refuses that. Give OWNER_TOKEN its own value");

    // Agent: only used to prove the Allowance is not delegated to it. Needs no SOL or USDC.
    if (!agent) problems.push(`AGENT_SOLANA_ADDRESS is not set; opening a task refuses without it. Run: ${NEW_AGENT}`);
    else if (!isAddress(agent)) problems.push(`AGENT_SOLANA_ADDRESS (${agent}) is not a Solana address. Clear it and run: ${NEW_AGENT}`);
    else if (agent === gate.address) problems.push("AGENT_SOLANA_ADDRESS equals the gate key; opening a task refuses to delegate to the agent. Use a separate agent address");
    else if (agent === owner.address) warnings.push("AGENT_SOLANA_ADDRESS equals the owner; the agent should not be the owner of the funds");

    // Seller: the x402 payTo. Payments transfer into its USDC token account, which must exist.
    if (!seller) problems.push(`SELLER_SOLANA_PAY_TO is not set; Solana purchases have no payTo. Run: ${NEW_SELLER}`);
    else if (!sellerValid) problems.push(`SELLER_SOLANA_PAY_TO (${seller}) is not a Solana address. Clear it and run: ${NEW_SELLER}`);
    else {
      if (!sellerAtaInfo?.value) {
        problems.push(`seller ${seller} has no USDC token account (expected ${sellerAta}); payments to it would fail. Run: npm run task -- seller-account`);
      }
      if (seller === gate.address || seller === owner.address) {
        warnings.push(`SELLER_SOLANA_PAY_TO is the ${seller === gate.address ? "gate" : "owner"}'s address; payments would go back to ourselves`);
      }
      if (seller === agent) warnings.push("SELLER_SOLANA_PAY_TO equals AGENT_SOLANA_ADDRESS; the agent would be paying itself (see README, Colosseum section)");
    }

    return {
      rpc: this.rpcUrl,
      mint: tokenMint,
      owner: { address: owner.address, sol_lamports: ownerSol.value.toString(), usdc_ata: ownerAta, usdc_ata_exists: !!ataInfo.value, usdc_atomic: usdc },
      gate: { address: gate.address, sol_lamports: gateSol.value.toString() },
      subscription_authority: { address: sa, exists: !!saInfo.value },
      agent: { address: agent },
      seller: { address: seller, usdc_ata: sellerAta, usdc_ata_exists: sellerAta ? !!sellerAtaInfo?.value : undefined },
      problems,
      warnings,
    };
  }

  /**
   * Create the seller's USDC token account, paid by the owner (the seller needs no SOL and does
   * not sign). Idempotent: does nothing if it exists.
   */
  async createSellerTokenAccount() {
    const seller = sellerSolanaAddress();
    if (!isAddress(seller)) throw new SolanaSetupError(`SELLER_SOLANA_PAY_TO is not set to a Solana address. Run: ${NEW_SELLER}`);
    const tokenMint = address(solanaMint());
    const [ata] = await findAssociatedTokenPda({ owner: address(seller), mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const existing = await createSolanaRpc(this.rpcUrl).getAccountInfo(ata, { encoding: "base64", commitment: "confirmed" }).send();
    if (existing.value) return { already_exists: true, seller, usdc_ata: ata };
    const owner = await ownerSigner();
    const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: address(seller), mint: tokenMint });
    const { context } = await clientFor(this.rpcUrl, owner).sendTransaction([ix]);
    return { signature: context.signature, seller, usdc_ata: ata };
  }

  /** One-time owner setup: the per-mint SubscriptionAuthority must exist before any Allowance. */
  async initOwnerAuthority() {
    const report = await this.preflight();
    const ownerProblems = report.problems.filter((p) => p.startsWith("owner"));
    if (ownerProblems.some((p) => /no devnet SOL|no USDC token account/.test(p))) {
      throw new SolanaSetupError(`cannot set up the SubscriptionAuthority yet:\n  - ${ownerProblems.join("\n  - ")}`);
    }
    if (report.subscription_authority.exists) {
      return { already_initialized: true, subscription_authority: report.subscription_authority.address };
    }
    // owner = the client's identity.
    const { context } = await clientFor(this.rpcUrl, await ownerSigner())
      .subscriptions.instructions.initSubscriptionAuthority({
        tokenMint: address(report.mint),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        userAta: address(report.owner.usdc_ata),
      })
      .sendTransaction();
    return { signature: context.signature, subscription_authority: report.subscription_authority.address };
  }
}

/** Decode a raw getAccountInfo result into the snapshot the ledger records. */
export function snapshotFromAccount(
  allowance: string,
  slot: bigint | number,
  account: { owner: string; data_base64: string } | null,
): AllowanceSnapshot {
  if (!account) return { address: allowance, slot: slot.toString(), exists: false };
  const d = getFixedDelegationDecoder().decode(getBase64Encoder().encode(account.data_base64));
  return {
    address: allowance,
    slot: slot.toString(),
    exists: true,
    owner_program: account.owner,
    data_base64: account.data_base64,
    decoded: {
      delegator: d.header.delegator,
      delegatee: d.header.delegatee,
      mint: d.mint,
      amount: d.amount.toString(),
      expiry_ts: d.expiryTs.toString(),
    },
  };
}

// Swappable so offline tests can run the gate against an in-memory chain.
let override: AllowanceChain | undefined;
export function setAllowanceChain(c: AllowanceChain | undefined) {
  override = c;
}
export function allowanceChain(): AllowanceChain {
  return override ?? new SolanaAllowanceChain();
}

