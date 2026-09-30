import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateFixedDelegationOverlayInstructionAsync,
  getFixedDelegationDecoder,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getTransferFixedOverlayInstructionAsync,
} from "@solana/subscriptions";
import { gateSigner, ownerSigner, solanaMint, solanaRpcUrl } from "./config";

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

async function sendAndConfirm(rpcUrl: string, feePayer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  // A preflight (simulation) failure throws a kit SolanaError whose context carries the
  // program logs; callers print it with formatSolanaError() (lib/solana/errors.ts).
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) {
      // Landed but failed: fetch the logs so the error is as informative as a simulation failure.
      const tx = await rpc
        .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
        .send()
        .catch(() => null);
      const err = new Error(`transaction ${signature} failed on chain`) as Error & { context?: unknown; cause?: unknown };
      err.context = { logs: tx?.meta?.logMessages ?? [] };
      err.cause = { message: `transaction error: ${JSON.stringify(st.err, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}` };
      throw err;
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return signature;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`transaction ${signature} not confirmed in time`);
}

/** A setup problem the owner must fix (missing SOL, missing token account, authority not set up). */
export class SolanaSetupError extends Error {}

export interface SetupReport {
  rpc: string;
  mint: string;
  owner: { address: string; sol_lamports: string; usdc_ata: string; usdc_ata_exists: boolean; usdc_atomic?: string };
  gate: { address: string; sol_lamports: string };
  subscription_authority: { address: string; exists: boolean };
  problems: string[];
}

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
    const ix = await getCreateFixedDelegationOverlayInstructionAsync({
      delegator: owner,
      delegatee: address(p.delegatee),
      tokenMint,
      nonce: p.nonce,
      amount: p.amount,
      expiryTs: p.expiryTs,
    });
    const signature = await sendAndConfirm(this.rpcUrl, owner, [ix]);
    return { address: delegation, signature };
  }

  async read(allowance: string): Promise<AllowanceSnapshot> {
    const rpc = createSolanaRpc(this.rpcUrl);
    const { context, value } = await rpc
      .getAccountInfo(address(allowance), { encoding: "base64", commitment: "confirmed" })
      .send();
    return snapshotFromAccount(allowance, context.slot, value ? { owner: value.owner, data_base64: value.data[0] } : null);
  }

  async revoke(allowance: string) {
    const owner = await ownerSigner();
    const ix = getRevokeDelegationOverlayInstruction({ authority: owner, delegationAccount: address(allowance) });
    return { signature: await sendAndConfirm(this.rpcUrl, owner, [ix]) };
  }

  async pull(allowance: string, amount: bigint) {
    const gate = await gateSigner();
    const owner = await this.ownerAddress();
    const tokenMint = address(solanaMint());
    const [ownerAta] = await findAssociatedTokenPda({ owner: address(owner), mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [gateAta] = await findAssociatedTokenPda({ owner: gate.address, mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const createGateAta = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: gate, owner: gate.address, mint: tokenMint });
    const transfer = await getTransferFixedOverlayInstructionAsync({
      amount,
      delegatee: gate,
      delegationPda: address(allowance),
      delegator: address(owner),
      delegatorAta: ownerAta,
      receiverAta: gateAta,
      tokenMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return { signature: await sendAndConfirm(this.rpcUrl, gate, [createGateAta, transfer]) };
  }

  /** One-time owner setup: the per-mint SubscriptionAuthority must exist before any Allowance. */
  /** Everything the owner and gate need before tasks can work, read from chain. */
  async preflight(): Promise<SetupReport> {
    const rpc = createSolanaRpc(this.rpcUrl);
    const owner = await ownerSigner();
    const gate = await gateSigner();
    const tokenMint = address(solanaMint());
    const [ownerAta] = await findAssociatedTokenPda({ owner: owner.address, mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [sa] = await findSubscriptionAuthorityPda({ user: owner.address, tokenMint });
    const [ownerSol, gateSol, ataInfo, saInfo] = await Promise.all([
      rpc.getBalance(owner.address, { commitment: "confirmed" }).send(),
      rpc.getBalance(gate.address, { commitment: "confirmed" }).send(),
      rpc.getAccountInfo(ownerAta, { encoding: "base64", commitment: "confirmed" }).send(),
      rpc.getAccountInfo(sa, { encoding: "base64", commitment: "confirmed" }).send(),
    ]);
    let usdc: string | undefined;
    if (ataInfo.value) usdc = (await rpc.getTokenAccountBalance(ownerAta, { commitment: "confirmed" }).send()).value.amount;
    const problems: string[] = [];
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
    return {
      rpc: this.rpcUrl,
      mint: tokenMint,
      owner: { address: owner.address, sol_lamports: ownerSol.value.toString(), usdc_ata: ownerAta, usdc_ata_exists: !!ataInfo.value, usdc_atomic: usdc },
      gate: { address: gate.address, sol_lamports: gateSol.value.toString() },
      subscription_authority: { address: sa, exists: !!saInfo.value },
      problems,
    };
  }

  async initOwnerAuthority() {
    const report = await this.preflight();
    const ownerProblems = report.problems.filter((p) => !p.startsWith("gate "));
    if (ownerProblems.some((p) => /no devnet SOL|no USDC token account/.test(p))) {
      throw new SolanaSetupError(`cannot set up the SubscriptionAuthority yet:\n  - ${ownerProblems.join("\n  - ")}`);
    }
    if (report.subscription_authority.exists) {
      return { already_initialized: true, subscription_authority: report.subscription_authority.address };
    }
    const owner = await ownerSigner();
    const ix = await getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner,
      tokenMint: address(report.mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta: address(report.owner.usdc_ata),
    });
    return { signature: await sendAndConfirm(this.rpcUrl, owner, [ix]), subscription_authority: report.subscription_authority.address };
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

