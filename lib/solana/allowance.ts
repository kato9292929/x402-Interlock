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
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return signature;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`transaction ${signature} not confirmed in time`);
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
  async initOwnerAuthority() {
    const owner = await ownerSigner();
    const tokenMint = address(solanaMint());
    const [ownerAta] = await findAssociatedTokenPda({ owner: owner.address, mint: tokenMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const ix = await getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner,
      tokenMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta: ownerAta,
    });
    return { signature: await sendAndConfirm(this.rpcUrl, owner, [ix]) };
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

