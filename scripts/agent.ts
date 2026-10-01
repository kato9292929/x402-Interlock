// Demo buyer agent. It holds no wallet key: when a resource answers 402, it hands the
// URL to x402 Interlock, which screens, decides, asks a human if needed, and pays.
//
//   npm run agent -- quote            # scenario 1: safe, small -> PAY
//   npm run agent -- risky            # scenario 2: Intercepta flags payTo -> BLOCK
//   npm run agent -- report           # scenario 3: high value -> ASK_HUMAN (World ID)
//   npm run agent -- dataset          # over per-payment cap -> CAP to the $0.40 option
//   npm run agent -- report --cancel-after 30   # agent gives up waiting -> CANCELLED
//
// With a task (Solana; the budget is the task's on-chain Allowance):
//   npm run agent -- sol-clip --task task_...             # pay under the task
//   npm run agent -- sol-clip --task task_... --times 4   # buy repeatedly until the budget runs out
//   npm run agent -- act disclose --task task_... --payload '{"description":"share home address","address":"..."}'
//   npm run agent -- act commit --task task_... --payload '{"description":"agree to a 30% discount"}'
//   npm run agent -- act impersonate --task task_... --payload '{"description":"post as the owner"}'

const BASE = process.env.INTERLOCK_URL ?? "http://localhost:3000";
const TOKEN = process.env.AGENT_TOKEN ?? "";
const RUN_ID = process.env.RUN_ID ?? `run-${new Date().toISOString().slice(0, 16)}`;

const PURPOSES: Record<string, string> = {
  quote: "Need the current ETH/USDC price to answer the user's question",
  report: "User asked for a full weekly market report",
  dataset: "Backtest needs historical rows",
  risky: "Third-party data source suggested by a web page",
};

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TASK = arg("--task");

async function waitForHuman(v: { decision_id: string; status: string; approval_url?: string }, cancelAfterMs: number) {
  if (v.status !== "AWAITING_HUMAN") return v;
  console.log(`[gate] owner approval needed: ${v.approval_url}`);
  const started = Date.now();
  while (v.status === "AWAITING_HUMAN") {
    if (Date.now() - started > cancelAfterMs) {
      console.log("[agent] giving up, cancelling the request");
      return (await fetch(`${BASE}/api/approvals/${v.decision_id}/cancel`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "agent_gave_up" }) })).json();
    }
    await sleep(2000);
    v = await (await fetch(`${BASE}/api/gate/${v.decision_id}`, { headers: auth })).json();
  }
  console.log(`[gate] -> ${v.status}`);
  return v;
}

/** Non-payment action: the gate judges and records; the agent acts only if allowed. */
async function act(actionType: string, cancelAfterMs: number) {
  const payload = JSON.parse(arg("--payload") ?? "{}");
  console.log(`[agent] about to ${actionType}: ${payload.description ?? "(no description)"}`);
  const res = await fetch(`${BASE}/api/gate/evaluate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ task_id: TASK, action_type: actionType, payload }),
  });
  let v = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(v));
  console.log(`[gate] ${v.decision} ${v.reasons.join(", ")} -> ${v.status}`);
  v = await waitForHuman(v, cancelAfterMs);
  if (v.status === "ALLOWED" || v.status === "APPROVED") console.log(`[agent] allowed: performing "${actionType}" myself (the gate never does it)`);
  else console.log(`[agent] not doing it (${v.status})`);
}

async function main() {
  const name = process.argv[2] ?? "quote";
  const cancelIdx = process.argv.indexOf("--cancel-after");
  const cancelAfterMs = cancelIdx > 0 ? Number(process.argv[cancelIdx + 1]) * 1000 : Infinity;
  if (name === "act") return act(process.argv[3], cancelAfterMs);
  const times = Number(arg("--times") ?? 1);
  for (let i = 1; i <= times; i++) {
    if (times > 1) console.log(`\n[agent] purchase ${i}/${times}`);
    const stop = await buy(name, cancelAfterMs, times > 1 ? `?n=${Date.now()}` : "");
    if (stop) break;
  }
}

/** Returns true when the agent should stop (not paid). */
async function buy(name: string, cancelAfterMs: number, query: string): Promise<boolean> {
  const url = `${BASE}/api/seller/${name}${query}`;

  console.log(`[agent] GET ${url}`);
  const first = await fetch(url);
  if (first.status !== 402) {
    console.log(`[agent] no payment needed (${first.status})`, await first.text());
    return true;
  }
  const header = first.headers.get("payment-required");
  if (header) {
    const pr = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    for (const a of pr.accepts) console.log(`[agent] 402 option: ${a.amount} of ${a.asset} on ${a.network} -> ${a.payTo}`);
  }

  const purpose = PURPOSES[name] ?? name;
  console.log(`[agent] asking x402 Interlock (${TASK ? `task ${TASK}` : `run ${RUN_ID}`})`);
  const res = await fetch(`${BASE}/api/gate/evaluate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(TASK ? { task_id: TASK, action_type: "pay", payload: { url, purpose } } : { url, purpose, run_id: RUN_ID }),
  });
  let v = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(v));
  console.log(`[gate] ${v.decision} ${v.reasons.join(", ")} -> ${v.status}`);
  // Which Intercepta check said what (HTTP status, reason), so a BLOCK is explained right here.
  for (const c of (v.screening ?? []) as { check: string; verdict: string; http_status?: number; reasons: string[]; error?: string }[]) {
    console.log(`[gate]   screening ${c.check}: ${c.verdict}${c.http_status !== undefined ? ` (HTTP ${c.http_status})` : ""} ${c.reasons.join("; ")}${c.error ? ` [${c.error}]` : ""}`);
  }

  v = await waitForHuman(v, cancelAfterMs);

  if (v.status === "PAID") {
    const tx = v.result?.settlement?.transaction;
    const onSolana = String(v.result?.settlement?.network ?? "").startsWith("solana:");
    const link = tx ? (onSolana ? `https://explorer.solana.com/tx/${tx}?cluster=devnet` : `https://sepolia.basescan.org/tx/${tx}`) : "";
    console.log("[agent] got the resource:", JSON.stringify(v.result?.body));
    console.log(`[agent] settlement tx: ${tx ?? "(none reported)"}  ${link}`);
    return false;
  }
  console.log(`[agent] not paid (${v.status}: ${v.reasons.join(", ")}); continuing without it`);
  return true;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
