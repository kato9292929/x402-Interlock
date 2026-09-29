// Owner CLI for tasks. Uses OWNER_TOKEN; the agent's token cannot do any of this.
//
//   npm run task -- open --purpose "Make one music video" --budget 1.00 --expires 2026-10-13T00:00:00Z
//   npm run task -- list
//   npm run task -- show task_...
//   npm run task -- close task_...          # revokes the Allowance on chain (irreversible)
//   npm run task -- init-authority          # one-time: owner's SubscriptionAuthority for USDC (direct, needs OWNER_SOLANA_PRIVATE_KEY)

import { SolanaAllowanceChain } from "../lib/solana/allowance";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const headers = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
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
  } else if (cmd === "init-authority") {
    console.log(await new SolanaAllowanceChain().initOwnerAuthority());
  } else {
    console.log("usage: npm run task -- open|list|show|close|init-authority");
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
