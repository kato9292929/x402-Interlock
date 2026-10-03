// Why did the gate decide what it did? Prints one decision from the ledger: the decision and
// its reasons, then every screening check with its HTTP status, reasons, error and the start of
// the raw Intercepta response, plus checks that were skipped and the Allowance reads.
//
//   npm run why                 # the latest payment decision
//   npm run why -- <decision_id>

import { Ledger, type LedgerEvent } from "../lib/ledger";

type Check = { check: string; verdict: string; http_status?: number; reasons: string[]; error?: string; response?: unknown; cache?: unknown };

const all = new Ledger().readAll();
const wanted = process.argv[2];
const id = wanted ?? [...all].reverse().find((e) => e.event_type === "screening_result" || e.event_type === "gate_decision")?.decision_id;
if (!id) {
  console.log("no decisions in the ledger yet");
  process.exit(0);
}
const events = all.filter((e) => e.decision_id === id);
if (!events.length) {
  console.log(`no events for ${id}`);
  process.exit(1);
}
const first = (t: string) => events.find((e) => e.event_type === t) as LedgerEvent | undefined;
const d = first("gate_decision")?.data as { decision?: string; reasons?: string[]; task_id?: string } | undefined;
const cand = first("payment_candidate")?.data as { resource?: string } | undefined;
console.log(`decision ${id}  at ${events[0].occurred_at}`);
if (cand?.resource) console.log(`  resource: ${cand.resource}`);
if (d) console.log(`  ${d.decision}  ${(d.reasons ?? []).join(", ")}${d.task_id ? `  (task ${d.task_id})` : ""}`);

for (const e of events.filter((x) => x.event_type === "allowance_checked")) {
  const a = e.data as { phase?: string; ok?: boolean; reason?: string; snapshot?: { slot?: string; decoded?: { amount?: string } } };
  console.log(`  allowance (${a.phase}): ${a.ok === false ? a.reason : "ok"}  slot ${a.snapshot?.slot ?? "-"}  remaining ${a.snapshot?.decoded?.amount ?? "-"}`);
}

const s = first("screening_result")?.data as
  | { verdict: string; reasons: string[]; checks: Check[]; skipped?: { check: string; code: string; detail: string }[]; screened_as?: unknown }
  | undefined;
if (!s) {
  console.log("  screening: not reached (stopped before screening)");
} else {
  console.log(`  screening: ${s.verdict}${s.screened_as ? `  as ${JSON.stringify(s.screened_as)}` : ""}`);
  if (!s.checks.length) console.log(`    no check ran: ${s.reasons.join("; ")}`);
  for (const c of s.checks) {
    const tag = c.http_status === 429 ? "  <- RATE LIMITED" : c.verdict === "UNAVAILABLE" ? "  <- this one" : "";
    console.log(`    ${c.check}: ${c.verdict}  HTTP ${c.http_status ?? "-"}${c.cache ? " (cached)" : ""}${tag}`);
    if (c.reasons.length) console.log(`      reasons: ${c.reasons.join("; ")}`);
    if (c.error) console.log(`      error:   ${c.error}`);
    if (c.response !== undefined) console.log(`      response: ${JSON.stringify(c.response).slice(0, 400)}`);
  }
  for (const k of s.skipped ?? []) console.log(`    ${k.check}: SKIPPED  ${k.code}  (${k.detail})`);
}
const sg = first("spend_guard_review")?.data as
  | { would_have: string; would_have_reasons: string[]; jev_status: string; jev_model: string | null; jev_reason?: string; necessity_prob: number | null; duplicate_prob: number | null; nature: string | null; policy_version: string; exact_repeat: boolean; cached: boolean; latency_ms: number }
  | undefined;
if (sg) {
  console.log(`  spend guard (shadow, did not change the decision): would_have ${sg.would_have}${sg.would_have_reasons.length ? ` (${sg.would_have_reasons.join(", ")})` : ""}`);
  if (sg.jev_status === "OK") console.log(`    necessity ${sg.necessity_prob}  duplicate ${sg.duplicate_prob}  nature ${sg.nature}  exact_repeat ${sg.exact_repeat}  model ${sg.jev_model}${sg.cached ? " (cached)" : ""}  ${sg.latency_ms} ms`);
  else console.log(`    Jev UNAVAILABLE: ${sg.jev_reason}`);
  console.log(`    policy ${sg.policy_version}`);
}
const dr = first("delivery_review")?.data as
  | { fields_ok: boolean; fields: { period: string; item_count: number | null; missing_fields: string[]; min_items_ok: boolean | null; status_ok: boolean; json: boolean }; body_size: number; latency_ms: number; jev_status: string; jev_model: string | null; jev_reason?: string; answers_prob: number | null; substance: string | null; substance_probabilities: Record<string, number> | null; fulfillment_score: number | null; policy_version: string }
  | undefined;
if (dr) {
  console.log(`  delivery review (record only): fields_ok ${dr.fields_ok}  period ${dr.fields.period}  items ${dr.fields.item_count}  missing [${dr.fields.missing_fields.join(", ")}]  ${dr.body_size} bytes  ${dr.latency_ms} ms`);
  if (dr.jev_status === "OK") console.log(`    answers ${dr.answers_prob}  substance ${dr.substance} ${JSON.stringify(dr.substance_probabilities)}  fulfillment ${dr.fulfillment_score}/10  model ${dr.jev_model}`);
  else console.log(`    Jev UNAVAILABLE: ${dr.jev_reason}`);
}
const r = first("payment_result")?.data as { status?: string; reason?: string } | undefined;
if (r) console.log(`  payment: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
