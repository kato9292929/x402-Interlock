// Stage 5 on devnet (spec/08): Spend Guard in confirm mode asks the owner; it never blocks.
// Since 2026-10-07 the shipped config has Spend Guard off: set spend_guard.mode to "confirm" in
// config/appe-thresholds.json before running this, or nothing is asked.
//   task "Make a 30-second music video ..." 0.40 USDC:
//     1. clip-city-night  needed      -> expected: paid, nobody asked
//     2. weather-tokyo    off-topic   -> expected: AWAITING_HUMAN with a SPEND_GUARD_ reason, not paid
//   task "Prepare the label's quarterly tax filing ..." 0.30 USDC:
//     3. music-track      off-topic   -> expected: AWAITING_HUMAN, not paid
// Then the owner opens the two approval URLs and rejects both (World ID is only needed to
// approve). Both purchases are off-topic, so "not needed" is the right label; approving one just
// to try the path would record a wrong label (the approve path is covered by the tests).
// One command: it starts the server if none is running (and stops it at the end), makes the
// three purchases, waits while the owner rejects the two asked ones on the approval pages, then
// prints what was paid and the owner's decisions recorded as labels (owner_decision_label).
// A server it starts gets WORLD_APPROVAL_TTL_SECONDS=600 (10 minutes to decide) unless that is set
// already; a server already running keeps its own setting.
// Run: npm run spend-guard-confirm-run          (`-- --check` only reads the ledger again)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Ledger } from "../lib/ledger";
import { ensureServer, explainFetchError, type Server } from "./lib/server";

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const owner = { authorization: `Bearer ${process.env.OWNER_TOKEN ?? ""}`, "content-type": "application/json" };
const agent = { authorization: `Bearer ${process.env.AGENT_TOKEN ?? ""}`, "content-type": "application/json" };
const EXPIRES = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
const STATE = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "spend-guard-confirm-run.json");

async function openTask(purpose: string, amount: string): Promise<string> {
  const res = await fetch(`${BASE}/api/tasks`, { method: "POST", headers: owner, body: JSON.stringify({ purpose, budget: { amount, asset: "USDC" }, expires_at: EXPIRES }) });
  const j = await res.json();
  if (!res.ok) throw new Error(`open task: HTTP ${res.status} ${JSON.stringify(j)}`);
  console.log(`task ${j.task_id}  "${purpose}"  ${amount} USDC`);
  return j.task_id;
}

async function buy(task_id: string, item: string, expect: string) {
  const url = `${BASE}/api/seller/sol-catalog/${item}`;
  const res = await fetch(`${BASE}/api/gate/evaluate`, { method: "POST", headers: agent, body: JSON.stringify({ task_id, action_type: "pay", payload: { url, purpose: item } }) });
  const v = await res.json();
  if (!res.ok) throw new Error(`evaluate: HTTP ${res.status} ${JSON.stringify(v)}`);
  const sg = v.spend_guard;
  console.log(`  ${item.padEnd(16)} ${v.decision} -> ${v.status}   (expected: ${expect})`);
  console.log(`    reasons: ${v.reasons.join(", ")}`);
  if (sg) {
    console.log(
      `    spend guard (${sg.mode}): ` +
        (sg.jev_status === "OK" ? `"necessary or useful" ${sg.necessity_alt_prob}, nature ${sg.nature}, would_have ${sg.would_have}` : `UNAVAILABLE: ${sg.jev_reason}`) +
        (sg.asked_owner ? "  -> asked the owner" : ""),
    );
  }
  if (v.approval_url) {
    const until = expiresAt(v.decision_id);
    console.log(`    approve or reject: ${v.approval_url}${until ? `   (open until ${new Date(until).toLocaleTimeString()}, ${Math.round((until - Date.now()) / 60_000)} min)` : ""}`);
  }
  return { item, decision_id: v.decision_id as string, status: v.status as string, asked: sg?.asked_owner === true };
}

function check() {
  if (!existsSync(STATE)) throw new Error("no run recorded yet: npm run spend-guard-confirm-run");
  const run = JSON.parse(readFileSync(STATE, "utf8")) as { item: string; decision_id: string; asked: boolean }[];
  const all = new Ledger().readAll();
  console.log("item              paid  asked by Spend Guard  owner's decision  label");
  for (const r of run) {
    const own = all.filter((e) => e.decision_id === r.decision_id);
    const paid = own.some((e) => e.event_type === "payment_result" && e.data.status === "PAID");
    const human = own.filter((e) => e.event_type === "human_verification").at(-1)?.data.status ?? "-";
    const label = own.find((e) => e.event_type === "owner_decision_label")?.data.label ?? "-";
    console.log(`${r.item.padEnd(17)} ${(paid ? "yes" : "no").padEnd(5)} ${(r.asked ? "yes" : "no").padEnd(21)} ${String(human).padEnd(17)} ${label}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DATA = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

/** When the approval request for a decision expires (from the request the server wrote). */
function expiresAt(decision_id: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(DATA, "approvals", `${decision_id}.json`), "utf8")) as { rp_context: { expires_at: number } }).rp_context.expires_at * 1000;
  } catch {
    return undefined;
  }
}

/** Wait until the owner has decided on every asked purchase (or its request has expired). */
async function waitForOwner(asked: { item: string; decision_id: string }[]) {
  const ends = asked.map((a) => expiresAt(a.decision_id)).filter((x): x is number => !!x);
  const deadline = (ends.length ? Math.max(...ends) : Date.now() + 600_000) + 15_000;
  const open = new Map(asked.map((a) => [a.decision_id, a.item]));
  console.log(`\nwaiting for you: open the URL(s) above and press reject (until ${new Date(deadline - 15_000).toLocaleTimeString()}; Ctrl+C stops)`);
  while (open.size && Date.now() < deadline) {
    for (const [id, item] of open) {
      // Reading the decision also closes it as expired once its time is up.
      const res = await fetch(`${BASE}/api/gate/${id}`, { headers: agent });
      const v = (await res.json()) as { status: string };
      if (v.status !== "AWAITING_HUMAN") {
        console.log(`  ${item}: ${v.status}`);
        open.delete(id);
      }
    }
    if (open.size) await sleep(3000);
  }
  for (const item of open.values()) console.log(`  ${item}: still waiting at the deadline`);
}

async function main() {
  if (process.argv.includes("--check")) return check();
  const server: Server = await ensureServer(BASE, owner, {
    name: "spend-guard-confirm-run",
    env: { WORLD_APPROVAL_TTL_SECONDS: process.env.WORLD_APPROVAL_TTL_SECONDS ?? "600" },
  });
  try {
    await run();
  } catch (e) {
    throw explainFetchError(e, server);
  } finally {
    await server.stop();
  }
}

async function run() {
  const video = await openTask('Make a 30-second music video for the single "Night Drive" (a late-night city mood)', "0.40");
  const r1 = await buy(video, "clip-city-night", "paid, nobody asked");
  const r2 = await buy(video, "weather-tokyo", "AWAITING_HUMAN, not paid");
  const tax = await openTask("Prepare the label's quarterly tax filing (Q3 2026), including overseas royalties", "0.30");
  const r3 = await buy(tax, "music-track", "AWAITING_HUMAN, not paid");
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify([r1, r2, r3]));

  const ok = r1.status === "PAID" && !r1.asked && r2.status === "AWAITING_HUMAN" && r2.asked && r3.status === "AWAITING_HUMAN" && r3.asked;
  console.log(`\n${ok ? "as expected so far" : "NOT as expected: paste this output"}.`);
  const asked = [r2, r3].filter((r) => r.status === "AWAITING_HUMAN");
  if (asked.length) await waitForOwner(asked);
  console.log("");
  check();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
