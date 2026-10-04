// Spend Guard shadow run on devnet, in one command (spec/07 stage 2):
//   task A "Make one music video" 1.00 USDC: buy sol-clip twice
//   task B "Prepare the quarterly tax filing" 0.30 USDC: buy sol-clip once
// then print what Spend Guard recorded for each purchase and check the stage 2 points.
// Needs `npm run dev` running in another terminal. Run: npm run spend-guard-run
import { Ledger } from "../lib/ledger";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const owner = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const agent = { authorization: `Bearer ${process.env.AGENT_TOKEN ?? ""}`, "content-type": "application/json" };
const EXPIRES = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

async function openTask(purpose: string, amount: string): Promise<string> {
  const res = await fetch(`${BASE}/api/tasks`, { method: "POST", headers: owner, body: JSON.stringify({ purpose, budget: { amount, asset: "USDC" }, expires_at: EXPIRES }) });
  const j = await res.json();
  if (!res.ok) throw new Error(`open task: HTTP ${res.status} ${JSON.stringify(j)}`);
  console.log(`task ${j.task_id}  "${purpose}"  ${amount} USDC  allowance ${j.allowance.pubkey}`);
  return j.task_id;
}

async function buy(task_id: string, n: number) {
  const url = `${BASE}/api/seller/sol-clip?n=${Date.now()}`;
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`seller answered ${first.status}, expected 402`);
  const res = await fetch(`${BASE}/api/gate/evaluate`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ task_id, action_type: "pay", payload: { url, purpose: "stock clip" } }),
  });
  const v = await res.json();
  if (!res.ok) throw new Error(`evaluate: HTTP ${res.status} ${JSON.stringify(v)}`);
  const sg = v.spend_guard;
  console.log(
    `  purchase ${n}: ${v.decision} ${v.reasons.join(", ")} -> ${v.status}` +
      (sg ? `\n    spend guard (shadow): would_have ${sg.would_have}${sg.would_have_reasons.length ? ` (${sg.would_have_reasons.join(", ")})` : ""} ` + (sg.jev_status === "OK" ? `necessity ${sg.necessity_prob} duplicate ${sg.duplicate_prob} nature ${sg.nature}` : `Jev UNAVAILABLE: ${sg.jev_reason}`) : "\n    spend guard: not asked"),
  );
  return v.decision_id as string;
}

async function main() {
  const probe = await fetch(`${BASE}/api/tasks`, { headers: owner }).catch(() => null);
  if (!probe) throw new Error(`nothing answers at ${BASE}: start \`npm run dev\` in another terminal (from ~/x402-Interlock)`);
  if (probe.status === 401) throw new Error("the server refused OWNER_TOKEN: check .env.local, then restart npm run dev");

  console.log("A. matching purpose, same clip endpoint twice");
  const a = await openTask("Make one music video", "1.00");
  const a1 = await buy(a, 1);
  const a2 = await buy(a, 2);
  console.log("\nB. unrelated purpose");
  const b = await openTask("Prepare the quarterly tax filing", "0.30");
  const b1 = await buy(b, 1);

  const all = new Ledger().readAll();
  const get = (id: string) => ({
    review: all.find((e) => e.decision_id === id && e.event_type === "spend_guard_review")?.data as Record<string, unknown> | undefined,
    paid: all.some((e) => e.decision_id === id && e.event_type === "payment_result" && e.data.status === "PAID"),
  });
  const rows = [
    ["A1", get(a1)],
    ["A2", get(a2)],
    ["B1", get(b1)],
  ] as const;

  console.log("\nrecorded (spend_guard_review):");
  console.log("     paid  necessity  duplicate  nature (probabilities)                                       would_have  model / policy_version / ms");
  for (const [k, { review: r, paid }] of rows) {
    if (!r) {
      console.log(`  ${k}  ${paid ? "PAID" : "no  "}  (no review recorded)`);
      continue;
    }
    console.log(
      `  ${k}  ${paid ? "PAID" : "no  "}  ${String(r.necessity_prob).padEnd(9)}  ${String(r.duplicate_prob).padEnd(9)}  ${String(r.nature).padEnd(12)} ${JSON.stringify(r.nature_probabilities).padEnd(48)} ${String(r.would_have).padEnd(10)}  ${r.jev_model ?? `UNAVAILABLE (${r.jev_reason})`} / ${r.policy_version} / ${r.latency_ms}${r.cached ? " cached" : ""}`,
    );
  }

  const [A1, A2, B1] = rows.map(([, x]) => x);
  const num = (v: unknown) => (typeof v === "number" ? v : NaN);
  const checks: [string, boolean][] = [
    ["every purchase PAID (shadow never stops a payment)", A1.paid && A2.paid && B1.paid],
    ["duplicate_prob higher on A2 than A1", num(A2.review?.duplicate_prob) > num(A1.review?.duplicate_prob)],
    ["B1 would_have block, and PAID", B1.review?.would_have === "block" && B1.paid],
    ["jev_model and policy_version on every review", rows.every(([, x]) => !!x.review?.jev_model && !!x.review?.policy_version)],
  ];
  console.log("\nchecks:");
  for (const [name, ok] of checks) console.log(`  ${ok ? "yes" : "NO "}  ${name}`);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
