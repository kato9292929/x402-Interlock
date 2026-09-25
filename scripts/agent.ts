// Demo buyer agent. It holds no wallet key: when a resource answers 402, it hands the
// URL to x402 Interlock, which screens, decides, asks a human if needed, and pays.
//
//   npm run agent -- quote            # scenario 1: safe, small -> PAY
//   npm run agent -- risky            # scenario 2: Intercepta flags payTo -> BLOCK
//   npm run agent -- report           # scenario 3: high value -> ASK_HUMAN (World ID)
//   npm run agent -- dataset          # over per-payment cap -> CAP to the $0.40 option
//   npm run agent -- report --cancel-after 30   # agent gives up waiting -> CANCELLED

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

async function main() {
  const name = process.argv[2] ?? "quote";
  const cancelIdx = process.argv.indexOf("--cancel-after");
  const cancelAfterMs = cancelIdx > 0 ? Number(process.argv[cancelIdx + 1]) * 1000 : Infinity;
  const url = `${BASE}/api/seller/${name}`;

  console.log(`[agent] GET ${url}`);
  const first = await fetch(url);
  if (first.status !== 402) {
    console.log(`[agent] no payment needed (${first.status})`, await first.text());
    return;
  }
  const header = first.headers.get("payment-required");
  if (header) {
    const pr = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    for (const a of pr.accepts) console.log(`[agent] 402 option: ${a.amount} of ${a.asset} on ${a.network} -> ${a.payTo}`);
  }

  console.log(`[agent] asking x402 Interlock (run ${RUN_ID})`);
  const res = await fetch(`${BASE}/api/gate/evaluate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ url, purpose: PURPOSES[name] ?? name, run_id: RUN_ID }),
  });
  let v = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(v));
  console.log(`[gate] ${v.decision} ${v.reasons.join(", ")} -> ${v.status}`);

  if (v.status === "AWAITING_HUMAN") {
    console.log(`[gate] owner approval needed: ${v.approval_url}`);
    const started = Date.now();
    while (v.status === "AWAITING_HUMAN") {
      if (Date.now() - started > cancelAfterMs) {
        console.log("[agent] giving up, cancelling the request");
        v = await (await fetch(`${BASE}/api/approvals/${v.decision_id}/cancel`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "agent_gave_up" }) })).json();
        break;
      }
      await sleep(2000);
      v = await (await fetch(`${BASE}/api/gate/${v.decision_id}`, { headers: auth })).json();
    }
    console.log(`[gate] -> ${v.status}`);
  }

  if (v.status === "PAID") console.log("[agent] got the resource:", JSON.stringify(v.result?.body));
  else console.log(`[agent] not paid (${v.status}); continuing without it`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
