// Find out what the TypeSafe API accepts for Delivery Review: send the real Delivery Review
// questions on a synthetic purchase, then variants that change one thing each, and print the
// HTTP status and the API's error text for every one. No task data, no keys printed.
// Run: npm run jev-probe-delivery
import { choice, noul, score, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { DELIVERY_QUESTIONS, SUBSTANCE_LABELS } from "../lib/delivery";
import { loadThresholds } from "../lib/appe";

const t = loadThresholds();
const body = JSON.stringify({ period: { from: "2026-09-27", to: "2026-10-03" }, items: [] });
const state = {
  request: { purpose: "Weekly streaming report", agent_purpose: "daily plays", requirements: { period: { from: "2026-09-27", to: "2026-10-03" }, required_fields: ["date", "plays"], min_items: 1 } },
  candidate: { description: "Daily streaming stats" },
  response: { body, truncated: false, fields: { status_ok: true, json: true, item_count: 0, missing_fields: ["date", "plays"], period: "match", min_items_ok: false, fields_ok: false }, latency_ms: 300, size_bytes: body.length, status: 200 },
};
const variants: [string, Questions, unknown][] = [
  ["as shipped (10-level score 0-9, all described)", DELIVERY_QUESTIONS, state],
  ["score 0-2 only", { ...DELIVERY_QUESTIONS, fulfillment: score("How fully?", ["none", "partly", "fully"]) }, state],
  ["no score question", { answers: DELIVERY_QUESTIONS.answers, substance: DELIVERY_QUESTIONS.substance }, state],
  ["noul only", { answers: noul("Does response.body answer request?") }, state],
  ["choice only", { substance: choice("What is it?", SUBSTANCE_LABELS) }, state],
  ["as shipped, state without nulls", DELIVERY_QUESTIONS, JSON.parse(JSON.stringify(state, (_k, v) => (v === null ? "none" : v)))],
];

async function main() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set in .env.local");
  const client = new TypeSafeClient({ baseURL: process.env.TYPESAFE_BASE_URL || undefined, logLevel: "off", timeout: 15_000, retry: { maxRetries: 0 } });
  for (const [name, questions, st] of variants) {
    try {
      const r = (await client.systemOne({ state: st as never, questions, model: t.providers.typesafe.model })) as { model: string; answers: Record<string, unknown> };
      console.log(`OK   ${name}  (${r.model})  ${JSON.stringify(r.answers)}`);
    } catch (e) {
      const err = e as { status?: number; body?: unknown; message?: string };
      console.log(`FAIL ${name}  HTTP ${err.status ?? "-"}  ${err.body !== undefined ? JSON.stringify(err.body).slice(0, 600) : err.message}`);
    }
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
