// Delivery Review run on devnet, in one command (spec/07 stage 3):
//   one task "Weekly streaming report for the artist, 2026-09-27 to 2026-10-03", 0.30 USDC
//   buy the same stats from three demo sellers (0.05 each): one that answers, one that returns
//   last year's data, one that returns no rows. Each purchase states what it needs.
// Then print what was recorded and check the stage 3 points. Needs `npm run dev` running.
// Run: npm run delivery-review-run
import { readFileSync } from "node:fs";
import { Ledger } from "../lib/ledger";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const owner = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const agent = { authorization: `Bearer ${process.env.AGENT_TOKEN ?? ""}`, "content-type": "application/json" };
const PERIOD = { from: "2026-09-27", to: "2026-10-03" };
const REQUIREMENTS = { period: PERIOD, required_fields: ["date", "plays", "listeners"], min_items: 1 };

async function main() {
  const probe = await fetch(`${BASE}/api/tasks`, { headers: owner }).catch(() => null);
  if (!probe) throw new Error(`nothing answers at ${BASE}: start \`npm run dev\` in another terminal (from ~/x402-Interlock)`);
  if (probe.status === 401) throw new Error("the server refused OWNER_TOKEN: check .env.local, then restart npm run dev");

  const res = await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ purpose: `Weekly streaming report for the artist, ${PERIOD.from} to ${PERIOD.to}`, budget: { amount: "0.30", asset: "USDC" }, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() }),
  });
  const task = await res.json();
  if (!res.ok) throw new Error(`open task: HTTP ${res.status} ${JSON.stringify(task)}`);
  console.log(`task ${task.task_id}  allowance ${task.allowance.pubkey}`);

  const runs: { name: string; id: string; body: unknown; status: string }[] = [];
  for (const name of ["sol-stats", "sol-stats-stale", "sol-stats-empty"]) {
    const url = `${BASE}/api/seller/${name}?from=${PERIOD.from}&to=${PERIOD.to}`;
    const r = await fetch(`${BASE}/api/gate/evaluate`, {
      method: "POST",
      headers: agent,
      body: JSON.stringify({ task_id: task.task_id, action_type: "pay", payload: { url, purpose: "daily plays and listeners for the report", requirements: REQUIREMENTS } }),
    });
    const v = await r.json();
    if (!r.ok) throw new Error(`evaluate ${name}: HTTP ${r.status} ${JSON.stringify(v)}`);
    const d = v.delivery_review;
    console.log(`\n${name}: ${v.decision} ${v.reasons.join(", ")} -> ${v.status}`);
    if (d) {
      console.log(`  code:  fields_ok ${d.fields_ok}  period ${d.period}  items ${d.item_count}  missing [${d.missing_fields.join(", ")}]`);
      console.log(`  Jev:   ` + (d.jev_status === "OK" ? `answers ${d.answers_prob}  substance ${d.substance}  fulfillment ${d.fulfillment_score}/9  (${d.jev_model})` : `UNAVAILABLE: ${d.jev_reason}`));
    } else console.log("  delivery review: not recorded");
    runs.push({ name, id: v.decision_id, body: v.result?.body, status: v.status });
  }

  const ledgerText = readFileSync(new Ledger().file, "utf8");
  const all = new Ledger().readAll();
  const rec = (id: string) => all.find((e) => e.decision_id === id && e.event_type === "delivery_review")?.data as Record<string, unknown> | undefined;
  const [good, stale, empty] = runs;
  console.log("\nrecorded (delivery_review):");
  for (const r of runs) {
    const d = rec(r.id);
    console.log(`  ${r.name.padEnd(16)} ${d ? `fields_ok ${d.fields_ok}  answers ${d.answers_prob}  substance ${d.substance} ${JSON.stringify(d.substance_probabilities)}  fulfillment ${d.fulfillment_score}  ${d.jev_model} / ${d.policy_version}  body ${d.body_size} B sha ${String(d.body_sha256).slice(0, 12)}…` : "none"}`);
  }
  // The ledger keeps hashes, not bodies: no purchased value may appear in it.
  const bodyLeaks = runs.filter((r) => r.body && JSON.stringify(r.body).length > 2 && ledgerText.includes(JSON.stringify(r.body)));
  const checks: [string, boolean][] = [
    ["all three PAID (Delivery Review never reverses a payment)", runs.every((r) => r.status === "PAID")],
    ["sol-stats-empty: substance empty", rec(empty.id)?.substance === "empty"],
    ["sol-stats-stale: period mismatch caught by code (fields_ok false)", rec(stale.id)?.fields_ok === false && (rec(stale.id)?.fields as { period?: string })?.period === "mismatch"],
    ["sol-stats: fields_ok true", rec(good.id)?.fields_ok === true],
    ["no purchased body in the ledger", bodyLeaks.length === 0],
    ["jev_model and policy_version on every review", runs.every((r) => !!rec(r.id)?.jev_model && !!rec(r.id)?.policy_version)],
  ];
  console.log("\nchecks:");
  for (const [n, ok] of checks) console.log(`  ${ok ? "yes" : "NO "}  ${n}`);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
