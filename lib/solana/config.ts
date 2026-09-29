import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";

// Solana settings. Everything is read at call time so tests and scripts can set env first.

export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SUBSCRIPTIONS_PROGRAM_ID = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";

export const solanaRpcUrl = () => process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const solanaNetwork = () => process.env.SOLANA_NETWORK ?? SOLANA_DEVNET;
export const solanaMint = () => process.env.SOLANA_USDC_MINT ?? USDC_DEVNET_MINT;
export const isSolanaNetwork = (network: string) => network.startsWith("solana:");

async function keypairFromEnv(name: string): Promise<KeyPairSigner> {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  // base58-encoded 64-byte secret key (the format solana-keygen / Phantom export).
  return createKeyPairSignerFromBytes(getBase58Encoder().encode(raw));
}

/** The gate's key: the Allowance delegatee, and the payer of x402 payments on Solana. */
export const gateSigner = () => keypairFromEnv("GATE_SOLANA_PRIVATE_KEY");

/**
 * The owner's key: the token owner (delegator) who creates and revokes Allowances.
 * Only the owner-authenticated task API uses it; the gate API never does.
 */
export const ownerSigner = () => keypairFromEnv("OWNER_SOLANA_PRIVATE_KEY");

/** The agent's public key, so issuance can refuse to delegate to it. */
export const agentSolanaAddress = () => process.env.AGENT_SOLANA_ADDRESS ?? "";
