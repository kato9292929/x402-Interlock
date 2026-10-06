// spec/07 section 4: Spend Guard against the owner's labels. The four metrics kept separate,
// the probability ranges per label, and candidate rules for both wordings of the necessity
// question. It decides nothing: the owner reads this, chooses, and writes the reason into
// config/appe-thresholds.json. Run: npm run appe-metrics
// Options: --boundary        only the boundary purchases (as npm run appe-label -- --boundary);
//                            the rest are left out of every number, not given a label
//          --items           also list every purchase: task, item, repeat or not, label, answers
//                            (read only; for reading why a purchase was called not needed)
//          --labels SOURCE   score only labels from one source: owner (pressed), decision (the owner's
//                            approvals and rejections in confirm mode) or rule (from a table)
//          --source NAME     whose answers to score: live (default: what the gate recorded) or a
//                            provider replayed with npm run appe-compare (typesafe, clef)
import { Ledger } from "../lib/ledger";
import { BOUNDARY, boundaryOf, candidateRules, judgedBy, quantiles, readiness, reviewRows, scoreRule, sources, taskLabels, type ReviewRow, type Rule } from "../lib/appe-eval";
import { loadThresholds } from "../lib/appe";
import { getTask } from "../lib/tasks";

const JEV_USD_PER_CALL = 0.00003; // the brief's figure (spec/07 section 4), not measured here
const pct = (v: number | null) => (v === null ? "  -  " : `${(v * 100).toFixed(0).padStart(3)}%`);
const f2 = (v: number | undefined) => (v === undefined ? "-" : v.toFixed(2));

const all = new Ledger().readAll();
const everything = reviewRows(all);
const boundary = process.argv.includes("--boundary");
const si = process.argv.indexOf("--source");
const source = si > 0 ? process.argv[si + 1] : "live";
if (!sources(everything).includes(source)) {
  console.error(`Error: no answers from ${source}; have: ${sources(everything).join(", ")}. Replay first: npm run appe-compare -- --provider ${source}`);
  process.exit(1);
}
// The boundary is chosen over every judge, before picking whose answers to score, so each
// source is scored on the same purchases.
const chosen = boundary ? everything.filter((r) => boundaryOf(r) === "boundary") : everything;
const li = process.argv.indexOf("--labels");
const labelSource = li > 0 ? process.argv[li + 1] : undefined;
if (labelSource && !["owner", "decision", "rule"].includes(labelSource)) {
  console.error("Error: --labels owner, decision or rule");
  process.exit(1);
}
// With --labels, labels from the other source are set aside (the purchases stay, unlabelled).
const rows = judgedBy(chosen, source).map((r) => (labelSource && r.label_source !== labelSource ? { ...r, label: undefined, label_source: undefined } : r));
const t = loadThresholds();
const ready = readiness(rows);

console.log(`policy ${t.policy_version}   validated: ${t.validated}   answers scored: ${source === "live" ? "live (as recorded in the gate)" : `${source} replay`}`);
if (labelSource) console.log(`labels scored: ${labelSource} only${labelSource === "owner" ? " (labels the owner pressed and kept; those that differed from the table were withdrawn, so these agree with it)" : ""}`);
if (boundary) {
  const c = (k: string) => everything.filter((r) => boundaryOf(r) === k).length;
  console.log(
    `境界のみで ${rows.length} 件 (boundary only: "necessary or useful" ${BOUNDARY.low.toFixed(2)}-${BOUNDARY.high.toFixed(2)} for any judge). ` +
      `Left out: ${c("above")} above, ${c("below")} below, ${c("no_value")} with no answer; none of them labelled automatically.`,
  );
  console.log("  These numbers describe the boundary only: they cannot show errors on purchases a judge was sure about, nor rate thresholds outside the range.");
}
const notAnswered = rows.filter((r) => r.jev_status !== "OK").length;
if (notAnswered) console.log(`  ${notAnswered} of them without an answer from ${source} (left out of the rules below)`);
console.log(`reviews ${rows.length}: needed ${ready.needed}, unneeded ${ready.unneeded}, not sure ${ready.unsure}, unlabelled ${ready.unlabelled}`);
{
  const bySource = (src: string) => rows.filter((r) => r.label && r.label_source === src).length;
  console.log(`labels: ${bySource("owner")} pressed by the owner, ${bySource("decision")} from the owner's approvals/rejections (marked + in --items), ${bySource("rule")} from a table by construction (rule_label; marked *)`);
}
if (!ready.ready) console.log("NOT ENOUGH for the section 4 decision yet: at least 30 labelled needed + unneeded, with both present.");

console.log("\n1. probability ranges by the owner's label (n min / median / max)");
function rangeOf(rs: ReviewRow[], label: string, pick: (r: ReviewRow) => number | null) {
  const q = quantiles(rs.filter((r) => r.label === label && r.jev_status === "OK").map(pick).filter((x): x is number => x !== null));
  return q ? `n ${String(q.n).padStart(2)}  ${f2(q.min)} / ${f2(q.median)} / ${f2(q.max)}` : "n  0";
}
const range = (label: string, pick: (r: ReviewRow) => number | null) => rangeOf(rows, label, pick);
for (const [name, pick] of [
  ["necessity (\"necessary\")         ", (r: ReviewRow) => r.necessity],
  ["necessity (\"necessary or useful\")", (r: ReviewRow) => r.necessity_alt],
  ["duplicate                        ", (r: ReviewRow) => r.duplicate],
] as const) {
  console.log(`  ${name}  needed: ${range("needed", pick)}   unneeded: ${range("unneeded", pick)}`);
}
const natures = (label: string) => {
  const c: Record<string, number> = {};
  for (const r of rows.filter((x) => x.label === label && x.nature)) c[r.nature!] = (c[r.nature!] ?? 0) + 1;
  return JSON.stringify(c);
};
console.log(`  nature                             needed: ${natures("needed")}   unneeded: ${natures("unneeded")}`);

const ruleName = (r: Rule) => `${r.wording === "necessary" ? "necessary         " : "necessary/useful  "} block<${r.block.toFixed(2)} ask<${r.ask.toFixed(2)} ${Number.isFinite(r.duplicate_ask) ? `dup>=${r.duplicate_ask.toFixed(2)}` : "dup off  "} ${r.nature_blocks ? "unrelated=block" : "nature unused  "}`;
const current: Rule = {
  wording: t.spend_guard.decision_wording ?? "necessary",
  block: t.spend_guard.necessity_block,
  ask: t.spend_guard.necessity_pass,
  duplicate_ask: t.spend_guard.duplicate_ask ?? Infinity,
  nature_blocks: true,
};

console.log("\n2. rules compared (labelled needed/unneeded only)");
console.log("   flagged→unneeded: of purchases the rule would ask about or block, share the owner called unneeded (metric 1, higher is better)");
console.log("   unneeded caught:  of purchases the owner called unneeded, share the rule flags");
console.log("   blocked→needed:   of purchases the rule would block, share the owner called needed (metric 2, lower is better)");
console.log("   asks:             extra owner checks the rule adds\n");
console.log("   rule                                                                   judged flagged flagged→unneeded unneeded caught blocked blocked→needed asks");
// Rows with nothing judged are left out, and a rule whose numbers equal the row above is folded
// into it, so the table stays readable.
let skipped = 0;
let prev = "";
for (const rule of [current, ...candidateRules(t.spend_guard.duplicate_ask ?? 0.5, boundary ? BOUNDARY : undefined)]) {
  const s = scoreRule(rows, rule);
  const tag = rule === current ? ` <- current (${t.validated ? "validated" : "provisional"})` : "";
  const sig = `${rule.wording}|${s.judged}|${s.flagged}|${s.flagged_unneeded_share}|${s.unneeded_caught}|${s.blocked}|${s.blocked_needed_share}|${s.asks}`;
  if (rule !== current && (s.judged === 0 || sig === prev)) {
    skipped++;
    continue;
  }
  prev = sig;
  console.log(`   ${ruleName(rule)}  ${String(s.judged).padStart(5)} ${String(s.flagged).padStart(7)}      ${pct(s.flagged_unneeded_share)}          ${pct(s.unneeded_caught)}     ${String(s.blocked).padStart(5)}      ${pct(s.blocked_needed_share)}     ${String(s.asks).padStart(3)}${tag}`);
}

if (skipped) console.log(`   (${skipped} more rules not shown: nothing labelled for them yet, or the same numbers as the row above)`);

if (boundary) console.log("   (boundary: only \"necessary or useful\" rules with thresholds inside the range; the current rule is shown for reference only)");

const others = sources(everything);
if (others.length > 1) {
  console.log(`\n2b. judges compared on the same ${chosen.length} purchases (labelled needed/unneeded; "necessary or useful", n min / median / max)`);
  for (const src of others) {
    const rs = judgedBy(chosen, src);
    const model = src === "live" ? ` (${[...new Set(rs.map((r) => r.provider))].join(", ")})` : ` ${rs.find((r) => r.replays[src]?.model)?.replays[src]?.model ?? ""}`;
    console.log(`  ${(src + model).padEnd(26)} needed: ${rangeOf(rs, "needed", (r) => r.necessity_alt)}   unneeded: ${rangeOf(rs, "unneeded", (r) => r.necessity_alt)}`);
  }
  console.log("  For the full rule table of one judge: npm run appe-metrics --" + (boundary ? " --boundary" : "") + " --source <name>");
}

console.log("\n3. task completion (owner's answer per task)");
const tl = [...taskLabels(all).values()];
const achieved = tl.filter((x) => x === "achieved").length;
const decided = tl.filter((x) => x !== "unsure").length;
console.log(`  ${achieved} of ${decided} tasks met their purpose (${tl.length - decided} not sure). Shadow mode stopped nothing, so this is the baseline.`);

console.log("\n4. cost");
if (source !== "live") console.log(`  (cost and latency below are for the replayed ${source} answers${source === "clef" ? "; a self-hosted server has no per-call price, its GPU cost is not measured here" : ""})`);
const calls = rows.filter((r) => r.jev_status === "OK" && !r.cached).length + rows.filter((r) => r.necessity_alt !== null).length;
const lat = quantiles(rows.map((r) => r.latency_ms));
const hosted = source === "live" ? rows.every((r) => r.provider === "typesafe") : source === "typesafe";
console.log(hosted ? `  Jev calls ~${calls} x $${JEV_USD_PER_CALL} = $${(calls * JEV_USD_PER_CALL).toFixed(5)} (price from the brief)` : `  calls ~${calls} (no per-call price)`);
console.log(`  latency ms: ${lat ? `min ${lat.min} / median ${lat.median} / max ${lat.max}` : "-"} (in parallel with Intercepta)`);
const unneededSpend = rows.filter((r) => r.label === "unneeded").reduce((s, r) => s + Number(r.amount) / 1e6, 0);
console.log(`  spend the owner called unneeded: ${unneededSpend.toFixed(2)} USDC; owner checks added: see "asks" per rule`);

if (process.argv.includes("--items")) {
  console.log("\n5. every purchase (# = order in the ledger; repeat = same URL earlier in the same task)");
  console.log("     #  task                          item                         repeat  label      necessary  or useful  duplicate  nature        boundary");
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.task_id}|${r.url}`;
    const repeat = seen.has(key);
    seen.add(key);
    const item = new URL(r.url).pathname.replace(/^\/api\/seller\/(sol-catalog\/)?/, "");
    const purpose = getTask(r.task_id)?.purpose ?? r.task_id;
    const f = (v: number | null) => (v === null ? "  -  " : v.toFixed(2)).padStart(9);
    console.log(
      `  ${String(everything.findIndex((x) => x.decision_id === r.decision_id) + 1).padStart(4)}  ${purpose.replace(/\s+/g, " ").slice(0, 28).padEnd(28)}  ${item.slice(0, 28).padEnd(28)} ${(repeat ? "yes" : "").padEnd(6)}  ${((r.label ?? "-") + (r.label_source === "rule" ? "*" : r.label_source === "decision" ? "+" : "")).padEnd(9)} ${f(r.necessity)}  ${f(r.necessity_alt)}  ${f(r.duplicate)}  ${(r.nature ?? r.jev_status).padEnd(12)}  ${boundaryOf(everything.find((x) => x.decision_id === r.decision_id)!)}`,
    );
  }
}
