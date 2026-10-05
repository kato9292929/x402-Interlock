import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../lib/ledger";
import { candidateRules, decide, readiness, reviewRows, scoreRule, taskLabels, type Rule } from "../lib/appe-eval";

let n = 0;
const ev = (decision_id: string, event_type: string, data: Record<string, unknown>): LedgerEvent =>
  ({ event_id: String(++n), decision_id, event_type, occurred_at: new Date(n * 1000).toISOString(), data, previous_event_hash: null, event_hash: "" }) as LedgerEvent;
const review = (id: string, necessity: number, alt: number, duplicate: number, nature: string) =>
  ev(id, "spend_guard_review", { mode: "shadow", task_id: "t1", url: `https://x/${id}`, amount: "30000", candidate_description: "d", jev_status: "OK", necessity_prob: necessity, necessity_alt_prob: alt, duplicate_prob: duplicate, nature, would_have: "block", latency_ms: 250 });
const label = (id: string, l: string) => ev(id, "owner_label", { target_decision_id: id, task_id: "t1", label: l });

// Two needed purchases that "necessary" scores low and "necessary or useful" scores high,
// one unneeded unrelated one, one unneeded repeat.
const events = [
  review("a", 0.22, 0.8, 0.08, "direct"),
  review("b", 0.26, 0.85, 0.1, "direct"),
  review("c", 0.02, 0.05, 0.07, "unrelated"),
  review("d", 0.3, 0.9, 0.89, "direct"),
  review("e", 0.5, 0.6, 0.1, "supporting"),
  label("a", "needed"),
  label("b", "needed"),
  label("c", "unneeded"),
  label("d", "unneeded"),
  label("e", "unsure"),
  ev("t1", "owner_task_label", { task_id: "t1", label: "achieved" }),
];
const rule = (r: Partial<Rule>): Rule => ({ wording: "necessary", block: 0.4, ask: 0.75, duplicate_ask: 0.5, nature_blocks: true, ...r });

test("rows join reviews with the owner's labels; task labels read back", () => {
  const rows = reviewRows(events);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.label), ["needed", "needed", "unneeded", "unneeded", "unsure"]);
  assert.equal(taskLabels(events).get("t1"), "achieved");
});

test("the provisional rule blocks the needed purchases; the other wording does not", () => {
  const rows = reviewRows(events);
  const strict = scoreRule(rows, rule({}));
  assert.equal(strict.blocked, 4);
  assert.equal(strict.blocked_needed_share, 0.5);
  const useful = scoreRule(rows, rule({ wording: "necessary_or_useful", block: 0.4 }));
  assert.equal(decide(rows[0], rule({ wording: "necessary_or_useful" })), "none");
  assert.equal(useful.blocked_needed_share, 0); // only the unrelated one is blocked
  assert.equal(useful.unneeded_caught, 1); // unrelated blocked, repeat asked about
  assert.equal(useful.flagged_unneeded_share, 1);
  assert.equal(useful.judged, 4); // "unsure" left out
});

test("readiness needs 30 labelled with both classes; candidate rules cover both wordings", () => {
  assert.equal(readiness(reviewRows(events)).ready, false);
  const rules = candidateRules(0.5);
  assert.ok(rules.some((r) => r.wording === "necessary") && rules.some((r) => r.wording === "necessary_or_useful"));
  assert.ok(rules.every((r) => r.ask > r.block));
});

test("a reset withdraws every label before it", () => {
  const withReset = [...events, ev("appe-labels", "owner_label_reset", { reason: "labelled at random" }), label("a", "unneeded")];
  const rows = reviewRows(withReset);
  assert.deepEqual(rows.map((r) => r.label), ["unneeded", undefined, undefined, undefined, undefined]);
  assert.equal(taskLabels(withReset).size, 0);
});
