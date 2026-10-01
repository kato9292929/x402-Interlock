import { createKeyPairSignerFromBytes, getBase58Decoder } from "@solana/kit";
import { randomBytes, webcrypto } from "node:crypto";

// Helpers for the owner CLI's setup commands (scripts/task.ts). Nothing here runs in the server.

/**
 * A fresh Ed25519 keypair as solana-keygen writes it: a JSON array of the 32-byte seed followed
 * by the 32-byte public key. Kit's own generator makes non-extractable keys, so use WebCrypto.
 */
export async function generateSolanaKeypair(): Promise<{ address: string; secretKey: Uint8Array }> {
  const kp = (await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const secretKey = new Uint8Array(64);
  secretKey.set(pkcs8.slice(-32), 0); // Ed25519 PKCS#8 ends with the 32-byte seed
  secretKey.set(pub, 32);
  // Round-trip through kit: it checks that the seed and the public key belong together.
  const signer = await createKeyPairSignerFromBytes(secretKey);
  if (signer.address !== getBase58Decoder().decode(pub)) throw new Error("generated keypair does not round-trip");
  return { address: signer.address, secretKey };
}

/** The value of `name` in an env file's text, as Node's --env-file would read it ("" if unset). */
export function envValue(text: string, name: string): string {
  let value = "";
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`).exec(line);
    if (m) value = m[1].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return value;
}

/**
 * Set `name=value` in an env file's text. An existing empty `name=` line (as copied from
 * .env.example) is replaced in place; otherwise the line is appended on a line of its own, so it
 * cannot run into the previous one. Refuses to overwrite a value that is already set.
 */
export function setEnvValue(text: string, name: string, value: string): string {
  const current = envValue(text, name);
  // Credentials are not echoed back; addresses are, so the owner can see which one is there.
  const shown = /TOKEN|KEY|SECRET/.test(name) ? "" : ` (${current})`;
  if (current) throw new Error(`${name} is already set in .env.local${shown}; not overwriting`);
  const re = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`, "m");
  if (re.test(text)) return text.replace(re, `${name}=${value}`);
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}${name}=${value}\n`;
}

/**
 * Set a new random bearer token `name` (e.g. OWNER_TOKEN) in an env file's text. Refuses if the
 * name already has a value, or if the new value equals any other *_TOKEN in the file or in `env`
 * (the task API refuses OWNER_TOKEN == AGENT_TOKEN). The token itself is never returned.
 */
export function setNewToken(text: string, name: string, env: Record<string, string | undefined> = {}, token = randomBytes(32).toString("base64url")): string {
  if (!/^[A-Z][A-Z0-9_]*_TOKEN$/.test(name)) throw new Error(`${name} is not a token variable (expected a name like OWNER_TOKEN)`);
  const others = new Set<string>();
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*_TOKEN)\s*=/gm)) if (m[1] !== name) others.add(m[1]);
  for (const k of Object.keys(env)) if (/_TOKEN$/.test(k) && k !== name) others.add(k);
  for (const other of others) {
    if (token === (envValue(text, other) || env[other])) throw new Error(`the new ${name} would equal ${other}; refusing`);
  }
  return setEnvValue(text, name, token);
}
