// Owner CLI for tasks. Uses OWNER_TOKEN; the agent's token cannot do any of this.
//
//   npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
//   npm run task -- list
//   npm run task -- show task_...
//   npm run task -- close task_...          # revokes the Allowance on chain (irreversible)
//   npm run task -- preflight               # check SOL, the owner's USDC token account and the authority (direct, read-only)
//   npm run task -- init-authority          # one-time: owner's SubscriptionAuthority for USDC (direct, needs OWNER_SOLANA_PRIVATE_KEY)

import { SolanaAllowanceChain, SolanaSetupError } from "../lib/solana/allowance";
import { formatSolanaError } from "../lib/solana/errors";

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
    if (!r.subscription_authority.exists) console.log("SubscriptionAuthority not set up yet: run `npm run task -- init-authority`");
  } else if (cmd === "init-authority") {
    const r = await new SolanaAllowanceChain().initOwnerAuthority();
    console.log(JSON.stringify(r, null, 2));
    if ("signature" in r) console.log(`\nhttps://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    else console.log("\nalready set up; nothing to do");
  } else {
    console.log("usage: npm run task -- open|list|show|close|preflight|init-authority");
  }
}

main().catch((e) => {
  // Setup problems are already written for a person; anything else is a chain error whose
  // simulation logs and causes would be lost by printing only e.message.
  console.error(e instanceof SolanaSetupError ? e.message : formatSolanaError(e));
  process.exit(1);
});
