// Stages 6-8 on devnet, in one command (owner's brief, 2026-10-08). Starts the server if none is
// running (approval window 600 s unless WORLD_APPROVAL_TTL_SECONDS is set), opens its own tasks,
// buys, prints what happened, lists the approval URLs at the end and waits for them, then closes
// the tasks it opened (revoking their Allowances). Nothing stops halfway for input.
//   stage 6  sol-stats-empty bought until its delivery history sends it to the owner
//            (DELIVERY_HISTORY_POOR / _MISMATCH)
//   stage 8  two 0.30 purchases at once in a 0.40 task: one is paid, the other is refused on
//            the reserved budget; then `reconcile --dry-run` over the ledger
// Run: npm run stages-run
import { ensureServer, explainFetchError, type Server } from "./lib/server";
import { reconcileUnconfirmed } from "../lib/reconcile";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const owner = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const agent = { authorization: `Bearer ${process.env.AGENT_TOKEN ?? ""}`, "content-type": "application/json" };
const EXPIRES = () => new Date(Date.now() + 24 * 3600_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REQ = { period: { from: "2026-09-27", to: "2026-10-03" }, required_fields: ["date", "plays", "listeners"], min_items: 1 };

interface View {
  decision_id: string;
  decision: string;
  status: string;
  reasons: string[];
  approval_url?: string;
}

async function openTask(purpose: string, amount: string): Promise<string> {
  const res = await fetch(`${BASE}/api/tasks`, { method: "POST", headers: owner, body: JSON.stringify({ purpose, budget: { amount, asset: "USDC" }, expires_at: EXPIRES() }) });
  const j = await res.json();
  if (!res.ok) throw new Error(`open task: HTTP ${res.status} ${JSON.stringify(j)}`);
  console.log(`  task ${j.task_id}  "${purpose}"  ${amount} USDC`);
  return j.task_id;
}

async function buy(task_id: string, path: string, requirements?: unknown): Promise<View> {
  const url = `${BASE}/api/seller/${path}${path.includes("?") ? "&" : "?"}n=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/gate/evaluate`, { method: "POST", headers: agent, body: JSON.stringify({ task_id, action_type: "pay", payload: { url, purpose: path, ...(requirements ? { requirements } : {}) } }) });
  const v = (await res.json()) as View;
  if (!res.ok) throw new Error(`evaluate: HTTP ${res.status} ${JSON.stringify(v)}`);
  console.log(`    ${path.padEnd(18)} ${v.decision} -> ${v.status}  ${v.reasons.join(", ")}`);
  return v;
}

async function run(opened: string[], asked: { what: string; v: View }[]) {
  console.log("\nstage 6: delivery history");
  const a = await openTask("Weekly streaming report for the artist, 2026-09-27 to 2026-10-03", "0.40");
  opened.push(a);
  let hist: View | undefined;
  for (let i = 0; i < 3 && !hist; i++) {
    const v = await buy(a, "sol-stats-empty", REQ);
    if (v.reasons.some((r) => r.startsWith("DELIVERY_HISTORY_"))) hist = v;
  }
  console.log(hist ? `  -> sent to the owner on its delivery history (${hist.reasons.filter((r) => r.startsWith("DELIVERY_HISTORY_")).join(", ")})` : "  -> NOT as expected: no DELIVERY_HISTORY_ reason after 3 purchases");
  if (hist?.approval_url) asked.push({ what: "sol-stats-empty after empty deliveries (reject it)", v: hist });

  console.log("\nstage 8: two purchases at once on one budget");
  const b = await openTask("Make one music video", "0.40");
  opened.push(b);
  const [x, y] = await Promise.all([buy(b, "sol-clip?agent=A"), buy(b, "sol-clip?agent=B")]);
  const paidN = [x, y].filter((v) => v.status === "PAID").length;
  const loser = [x, y].find((v) => v.status !== "PAID");
  console.log(paidN === 1 ? `  -> one paid, the other refused: ${loser?.reasons.join(", ")}` : `  -> NOT as expected: ${paidN} paid`);

  console.log("\nstage 8: payments with an unknown outcome (reconcile, dry run)");
  const rows = await reconcileUnconfirmed({ dryRun: true });
  console.log(rows.length ? rows.map((r) => `  ${r.outcome} ${r.decision_id} ${r.detail}`).join("\n") : "  none in this ledger");
}

async function waitFor(asked: { what: string; v: View }[]) {
  if (!asked.length) return;
  console.log("\napproval needed (the only manual step):");
  for (const a of asked) console.log(`  ${a.what}\n    ${a.v.approval_url}`);
  const open = new Map(asked.map((a) => [a.v.decision_id, a.what]));
  const deadline = Date.now() + Number(process.env.WORLD_APPROVAL_TTL_SECONDS ?? 600) * 1000 + 15_000;
  while (open.size && Date.now() < deadline) {
    for (const [id, what] of open) {
      const v = (await (await fetch(`${BASE}/api/gate/${id}`, { headers: agent })).json()) as View;
      if (v.status !== "AWAITING_HUMAN") {
        console.log(`  ${what}: ${v.status}`);
        open.delete(id);
      }
    }
    if (open.size) await sleep(3000);
  }
}

async function main() {
  const server: Server = await ensureServer(BASE, owner, { name: "stages-run", env: { WORLD_APPROVAL_TTL_SECONDS: process.env.WORLD_APPROVAL_TTL_SECONDS ?? "600" } });
  const opened: string[] = [];
  const asked: { what: string; v: View }[] = [];
  try {
    await run(opened, asked);
    await waitFor(asked);
  } catch (e) {
    throw explainFetchError(e, server);
  } finally {
    console.log("\ncleanup: closing the tasks this run opened");
    for (const id of opened) {
      const res = await fetch(`${BASE}/api/tasks/${id}/close`, { method: "POST", headers: owner }).catch(() => null);
      const j = res ? await res.json().catch(() => ({})) : {};
      console.log(`  ${id}: ${res?.ok ? `closed${j.revoke_tx ? ` (revoke ${j.revoke_tx})` : ""}` : `not closed (${res?.status ?? "no answer"} ${JSON.stringify(j).slice(0, 120)})`}`);
    }
    await server.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
