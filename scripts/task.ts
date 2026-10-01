// Owner CLI for tasks. Uses OWNER_TOKEN; the agent's token cannot do any of this.
//
//   npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
//   npm run task -- list
//   npm run task -- show task_...
//   npm run task -- close task_...          # revokes the Allowance on chain (irreversible)
//   npm run task -- preflight               # check SOL, the owner's USDC token account and the authority (direct, read-only)
//   npm run task -- init-authority          # one-time: owner's SubscriptionAuthority for USDC (direct, needs OWNER_SOLANA_PRIVATE_KEY)
//   npm run task -- new-address seller --env SELLER_SOLANA_PAY_TO   # new keypair in keys/seller.json; address into .env.local
//   npm run task -- seller-account          # create the seller's USDC token account, paid by the owner (direct)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SolanaAllowanceChain, SolanaSetupError } from "../lib/solana/allowance";
import { formatSolanaError } from "../lib/solana/errors";
import { generateSolanaKeypair, setEnvValue } from "../lib/solana/setup";

const ENV_FILE = ".env.local";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const headers = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) {
    // The API returns the chain error already explained (causes, program error, logs).
    const d = json.details as { causes?: string[]; program_error?: string; hint?: string; logs?: string[] } | undefined;
    const lines = [`HTTP ${res.status}: ${json.error}`];
    for (const c of d?.causes ?? []) lines.push(`  cause: ${c}`);
    if (d?.program_error) lines.push(`  program error: ${d.program_error}`);
    if (d?.hint) lines.push(`  hint: ${d.hint}`);
    if (d?.logs?.length) lines.push("  simulation logs:", ...d.logs.map((l) => `    ${l}`));
    throw new SolanaSetupError(lines.join("\n"));
  }
  return json;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "open") {
    const t = await call("POST", "/api/tasks", {
      purpose: arg("--purpose") ?? "",
      budget: { amount: arg("--budget") ?? "", asset: "USDC" },
      expires_at: arg("--expires") ?? new Date(Date.now() + 24 * 3600_000).toISOString(),
    });
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nAllowance: https://explorer.solana.com/address/${t.allowance.pubkey}?cluster=devnet`);
    console.log(`Create tx: https://explorer.solana.com/tx/${t.allowance.create_tx}?cluster=devnet`);
  } else if (cmd === "list") {
    console.log(JSON.stringify(await call("GET", "/api/tasks"), null, 2));
  } else if (cmd === "show") {
    console.log(JSON.stringify(await call("GET", `/api/tasks/${process.argv[3]}`), null, 2));
  } else if (cmd === "close") {
    const t = await call("POST", `/api/tasks/${process.argv[3]}/close`);
    console.log(JSON.stringify(t, null, 2));
    console.log(`\nRevoke tx: https://explorer.solana.com/tx/${t.revoke_tx}?cluster=devnet`);
  } else if (cmd === "preflight") {
    const r = await new SolanaAllowanceChain().preflight();
    console.log(JSON.stringify(r, null, 2));
    console.log(r.problems.length ? `\n${r.problems.length} problem(s):\n  - ${r.problems.join("\n  - ")}` : "\nall set");
    if (r.warnings.length) console.log(`\nwarning(s):\n  - ${r.warnings.join("\n  - ")}`);
    if (!r.subscription_authority.exists) console.log("SubscriptionAuthority not set up yet: run `npm run task -- init-authority`");
  } else if (cmd === "init-authority") {
    const r = await new SolanaAllowanceChain().initOwnerAuthority();
    console.log(JSON.stringify(r, null, 2));
    if ("signature" in r) console.log(`\nhttps://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    else console.log("\nalready set up; nothing to do");
  } else if (cmd === "new-address") {
    await newAddress(process.argv[3], arg("--env"));
  } else if (cmd === "seller-account") {
    const r = await new SolanaAllowanceChain().createSellerTokenAccount();
    console.log(JSON.stringify(r, null, 2));
    if ("signature" in r) console.log(`\nhttps://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    else console.log("\nalready exists; nothing to do");
  } else {
    console.log("usage: npm run task -- open|list|show|close|preflight|init-authority|new-address|seller-account");
  }
}

// A demo address (agent or seller). The secret key goes to keys/<name>.json (git-ignored, in
// solana-keygen's format) so the funds stay recoverable; only the public address goes into .env.local.
async function newAddress(name: string | undefined, envName: string | undefined) {
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new SolanaSetupError("usage: npm run task -- new-address <name> [--env VAR]   (name: a-z, 0-9, -)");
  const file = `keys/${name}.json`;
  if (existsSync(file)) throw new SolanaSetupError(`${file} already exists; not overwriting. Use another name or delete it first`);
  const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const kp = await generateSolanaKeypair();
  // Check .env.local first, so a refusal leaves no orphan key file behind.
  let nextEnv: string | undefined;
  try {
    nextEnv = envName ? setEnvValue(envText, envName, kp.address) : undefined;
  } catch (e) {
    throw new SolanaSetupError((e as Error).message);
  }
  mkdirSync("keys", { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + "\n", { mode: 0o600 });
  if (nextEnv !== undefined) writeFileSync(ENV_FILE, nextEnv);
  console.log(JSON.stringify({ name, address: kp.address, keypair_file: file, env: envName ? `${envName} written to ${ENV_FILE}` : undefined }, null, 2));
}

main().catch((e) => {
  // Setup problems are already written for a person; anything else is a chain error whose
  // simulation logs and causes would be lost by printing only e.message.
  console.error(e instanceof SolanaSetupError ? e.message : formatSolanaError(e));
  process.exit(1);
});
