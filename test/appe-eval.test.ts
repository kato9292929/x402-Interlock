import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../lib/ledger";
import { boundaryOf, candidateRules, checkRuleFile, planRuleLabels, decide, judgedBy, readiness, reviewRows, scoreRule, sources, taskLabels, type Rule } from "../lib/appe-eval";

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

const replay = (id: string, provider: string, alt: number | null, status = "OK") =>
  ev(id, "spend_guard_replay", { target_decision_id: id, provider, status, model: status === "OK" ? `${provider}-m` : null, necessity_prob: alt, necessity_alt_prob: alt, duplicate_prob: 0.1, nature: "direct", latency_ms: 900 });

test("boundary: 0.30-0.85 for any judge; outside it skipped as above / below; opposite sides count as boundary", () => {
  const rows = reviewRows([
    ...events,
    replay("c", "clef", 0.5), // live 0.05 (below), clef inside -> boundary
    replay("d", "clef", 0.95), // live 0.90 (above), clef above -> above
  ]);
  assert.deepEqual(rows.map((r) => boundaryOf(r)), ["boundary", "boundary", "boundary", "above", "boundary"]);
  const split = reviewRows([review("x", 0.1, 0.95, 0.1, "direct"), replay("x", "clef", 0.05)]);
  assert.equal(boundaryOf(split[0]), "boundary");
  const none = reviewRows([ev("y", "spend_guard_review", { mode: "shadow", task_id: "t1", url: "https://x/y", amount: "1", jev_status: "UNAVAILABLE", necessity_prob: null, would_have: "ask_human" })]);
  assert.equal(boundaryOf(none[0]), "no_value");
  assert.equal(boundaryOf(reviewRows([review("z", 0.1, 0.05, 0.1, "unrelated")])[0]), "below");
});

test("judgedBy scores a replay's answers; purchases it did not answer are left out", () => {
  const all = [...events, replay("a", "clef", 0.1), replay("c", "clef", 0.9), replay("b", "clef", null, "UNAVAILABLE")];
  const rows = reviewRows(all);
  assert.deepEqual(sources(rows), ["live", "clef"]);
  const clef = judgedBy(rows, "clef");
  assert.deepEqual(clef.map((r) => r.jev_status), ["OK", "UNAVAILABLE", "OK", "NOT_REPLAYED", "NOT_REPLAYED"]);
  assert.equal(clef[0].necessity_alt, 0.1);
  assert.equal(clef[0].label, "needed"); // labels belong to the purchase, not to a judge
  const s = scoreRule(clef, rule({ wording: "necessary_or_useful", block: 0.4 }));
  assert.equal(s.judged, 2); // a (needed, blocked by clef) and c (unneeded, unrelated by live but direct by clef)
  assert.equal(s.blocked_needed_share, 1);
  assert.equal(judgedBy(rows, "live"), rows);
});

test("boundary rules: only \"necessary or useful\", thresholds inside the range", () => {
  const rules = candidateRules(0.5, { low: 0.3, high: 0.85 });
  assert.ok(rules.length > 0);
  assert.ok(rules.every((r) => r.wording === "necessary_or_useful" && r.ask >= 0.3 && r.ask <= 0.85 && (r.block === 0 || (r.block >= 0.3 && r.block <= 0.85))));
});

test("labels by construction: applied where nobody pressed; an owner label is never overwritten, a difference is listed", () => {
  const url = (item: string) => `http://h/api/seller/sol-catalog/${item}`;
  const r = (id: string, task: string, item: string) => ev(id, "spend_guard_review", { mode: "shadow", task_id: task, url: url(item), amount: "1", jev_status: "OK", necessity_alt_prob: 0.5, would_have: "none" });
  const table = {
    basis: "by construction",
    groups: {
      video: { purpose_contains: ["music video"], needed: ["clip-city-night"], unneeded: ["weather-tokyo"], unsure: ["font-license"] },
      report: { purpose_contains: ["streaming report"], unneeded: ["clip-city-night"] },
    },
    task_label: "achieved" as const,
  };
  assert.deepEqual(checkRuleFile(table), []);
  assert.match(checkRuleFile({ ...table, basis: " ", groups: { x: { purpose_contains: ["a"], needed: ["i"], unneeded: ["i"] } } }).join(" "), /basis.*i is both needed and unneeded/);
  const evs = [
    r("v1", "tv", "clip-city-night"),
    r("v2", "tv", "clip-city-night"), // repeat: the item's label
    r("v3", "tv", "weather-tokyo"),
    r("v4", "tv", "render-minutes"), // not in the table
    r("r1", "tr", "clip-city-night"), // same item, other task: other label
    r("x1", "tx", "eth-spot"), // task in no group
    label("v2", "unneeded"), // the owner pressed it the old way
    label("v3", "unneeded"), // the owner agrees with the table
  ];
  const purposes: Record<string, string> = { tv: "Make a 30-second Music Video", tr: "Weekly streaming report", tx: "ETH price" };
  const plan = planRuleLabels(reviewRows(evs), table, (id) => purposes[id]);
  assert.deepEqual(plan.apply.map((a) => [a.row.decision_id, a.label]), [["v1", "needed"], ["r1", "unneeded"]]);
  assert.deepEqual(plan.same.map((x) => x.decision_id), ["v3"]);
  assert.deepEqual(plan.conflicts.map((c) => [c.row.decision_id, c.owner, c.table]), [["v2", "unneeded", "needed"]]);
  assert.deepEqual(plan.unmatched.map((u) => u.row.decision_id), ["v4", "x1"]);

  // Written as rule_label: counted like a label, marked as by rule; an owner label still wins, whatever the order.
  const written = [...evs, ...plan.apply.map((a) => ev(a.row.decision_id, "rule_label", { target_decision_id: a.row.decision_id, task_id: a.row.task_id, label: a.label })), ev("v2", "rule_label", { target_decision_id: "v2", label: "needed" }), ev("tv", "rule_task_label", { task_id: "tv", label: "achieved" }), ev("tr", "owner_task_label", { task_id: "tr", label: "not_achieved" }), ev("tr", "rule_task_label", { task_id: "tr", label: "achieved" })];
  const rows = reviewRows(written);
  const by = (id: string) => rows.find((x) => x.decision_id === id)!;
  assert.deepEqual([by("v1").label, by("v1").label_source], ["needed", "rule"]);
  assert.deepEqual([by("v2").label, by("v2").label_source], ["unneeded", "owner"]);
  assert.equal(by("v4").label, undefined);
  assert.equal(taskLabels(written).get("tv"), "achieved");
  assert.equal(taskLabels(written).get("tr"), "not_achieved");
});

test("an owner label taken back (owner_label_withdrawn) gives way to the table; a later press wins again", () => {
  const base = [review("a", 0.2, 0.8, 0.9, "direct"), label("a", "unneeded"), ev("a", "rule_label", { target_decision_id: "a", label: "needed" })];
  assert.deepEqual([reviewRows(base)[0].label, reviewRows(base)[0].label_source], ["unneeded", "owner"]);
  const withdrawn = [...base, ev("a", "owner_label_withdrawn", { kind: "purchase", target_decision_id: "a", previous_label: "unneeded", reason: "repeats are for duplicate" })];
  assert.deepEqual([reviewRows(withdrawn)[0].label, reviewRows(withdrawn)[0].label_source], ["needed", "rule"]);
  const pressedAgain = [...withdrawn, label("a", "unsure")];
  assert.deepEqual([reviewRows(pressedAgain)[0].label, reviewRows(pressedAgain)[0].label_source], ["unsure", "owner"]);
  const tasks = [ev("t1", "owner_task_label", { task_id: "t1", label: "not_achieved" }), ev("t1", "rule_task_label", { task_id: "t1", label: "achieved" })];
  assert.equal(taskLabels(tasks).get("t1"), "not_achieved");
  assert.equal(taskLabels([...tasks, ev("t1", "owner_label_withdrawn", { kind: "task", task_id: "t1", reason: "x" })]).get("t1"), "achieved");
});
