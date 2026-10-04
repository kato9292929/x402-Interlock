// spec/07 section 4: run the 34 purchases of config/appe-eval-scenarios.json on devnet with
// Spend Guard in shadow mode, so the owner can label them (npm run appe-label).
// Needs `npm run dev` running. A purchase the fixed rules send to the owner (a repeat within
// 10 minutes) is cancelled here; Spend Guard has already reviewed it.
// Run: npm run appe-eval-run            (all tasks)
//      npm run appe-eval-run -- venue   (one task, by key)
import { readFileSync } from "node:fs";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const owner = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const agent = { authorization: `Bearer ${process.env.AGENT_TOKEN ?? ""}`, "content-type": "application/json" };
const scenarios = JSON.parse(readFileSync("config/appe-eval-scenarios.json", "utf8")) as { tasks: { key: string; purpose: string; budget: string; buy: string[] }[] };
const only = process.argv[2];
const fmt = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "-");

async function main() {
  const probe = await fetch(`${BASE}/api/tasks`, { headers: owner }).catch(() => null);
  if (!probe) throw new Error(`nothing answers at ${BASE}: start \`npm run dev\` in another terminal (from ~/x402-Interlock)`);
  if (probe.status === 401) throw new Error("the server refused OWNER_TOKEN: check .env.local, then restart npm run dev");
  const tasks = scenarios.tasks.filter((t) => !only || t.key === only);
  if (!tasks.length) throw new Error(`no task with key ${only}; keys: ${scenarios.tasks.map((t) => t.key).join(", ")}`);
  let done = 0;
  const total = tasks.reduce((n, t) => n + t.buy.length, 0);
  for (const t of tasks) {
    const res = await fetch(`${BASE}/api/tasks`, { method: "POST", headers: owner, body: JSON.stringify({ purpose: t.purpose, budget: { amount: t.budget, asset: "USDC" }, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() }) });
    const task = await res.json();
    if (!res.ok) throw new Error(`open task ${t.key}: HTTP ${res.status} ${JSON.stringify(task)}`);
    console.log(`\n[${t.key}] ${task.task_id}  "${t.purpose}"  ${t.budget} USDC`);
    for (const item of t.buy) {
      const url = `${BASE}/api/seller/sol-catalog/${item}`;
      const first = await fetch(url);
      if (first.status !== 402) throw new Error(`${item}: seller answered ${first.status}, expected 402`);
      const r = await fetch(`${BASE}/api/gate/evaluate`, { method: "POST", headers: agent, body: JSON.stringify({ task_id: task.task_id, action_type: "pay", payload: { url, purpose: item } }) });
      const v = await r.json();
      if (!r.ok) throw new Error(`evaluate ${item}: HTTP ${r.status} ${JSON.stringify(v)}`);
      if (v.status === "AWAITING_HUMAN") await fetch(`${BASE}/api/approvals/${v.decision_id}/cancel`, { method: "POST", headers: agent, body: JSON.stringify({ reason: "appe_eval_run" }) });
      const sg = v.spend_guard;
      done++;
      console.log(
        `  ${String(done).padStart(2)}/${total} ${item.padEnd(28)} ${String(v.status).padEnd(15)} ` +
          (sg ? (sg.jev_status === "OK" ? `would_have ${sg.would_have.padEnd(9)} necessity ${fmt(sg.necessity_prob)} duplicate ${fmt(sg.duplicate_prob)} nature ${sg.nature}` : `Jev UNAVAILABLE: ${sg.jev_reason}`) : "spend guard not asked"),
      );
    }
  }
  console.log(`\n${done} purchases reviewed. Next: npm run appe-label`);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
