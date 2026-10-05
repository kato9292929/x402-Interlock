// spec/07 section 4: Spend Guard against the owner's labels. The four metrics kept separate,
// the probability ranges per label, and candidate rules for both wordings of the necessity
// question. It decides nothing: the owner reads this, chooses, and writes the reason into
// config/appe-thresholds.json. Run: npm run appe-metrics
import { Ledger } from "../lib/ledger";
import { candidateRules, quantiles, readiness, reviewRows, scoreRule, taskLabels, type ReviewRow, type Rule } from "../lib/appe-eval";
import { loadThresholds } from "../lib/appe";

const JEV_USD_PER_CALL = 0.00003; // the brief's figure (spec/07 section 4), not measured here
const pct = (v: number | null) => (v === null ? "  -  " : `${(v * 100).toFixed(0).padStart(3)}%`);
const f2 = (v: number | undefined) => (v === undefined ? "-" : v.toFixed(2));

const all = new Ledger().readAll();
const rows = reviewRows(all);
const t = loadThresholds();
const ready = readiness(rows);

console.log(`policy ${t.policy_version}   validated: ${t.validated}`);
console.log(`reviews ${rows.length}: needed ${ready.needed}, unneeded ${ready.unneeded}, not sure ${ready.unsure}, unlabelled ${ready.unlabelled}`);
if (!ready.ready) console.log("NOT ENOUGH for the section 4 decision yet: at least 30 labelled needed + unneeded, with both present.");

console.log("\n1. probability ranges by the owner's label (n min / median / max)");
const range = (label: string, pick: (r: ReviewRow) => number | null) => {
  const q = quantiles(rows.filter((r) => r.label === label).map(pick).filter((x): x is number => x !== null));
  return q ? `n ${String(q.n).padStart(2)}  ${f2(q.min)} / ${f2(q.median)} / ${f2(q.max)}` : "n  0";
};
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

const ruleName = (r: Rule) => `${r.wording === "necessary" ? "necessary         " : "necessary/useful  "} block<${r.block.toFixed(2)} ask<${r.ask.toFixed(2)} dup>=${r.duplicate_ask.toFixed(2)} ${r.nature_blocks ? "unrelated=block" : "nature unused  "}`;
const current: Rule = { wording: "necessary", block: t.spend_guard.necessity_block, ask: t.spend_guard.necessity_pass, duplicate_ask: t.spend_guard.duplicate_ask, nature_blocks: true };

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
for (const rule of [current, ...candidateRules(t.spend_guard.duplicate_ask)]) {
  const s = scoreRule(rows, rule);
  const tag = rule === current ? " <- current (provisional)" : "";
  const sig = `${rule.wording}|${s.judged}|${s.flagged}|${s.flagged_unneeded_share}|${s.unneeded_caught}|${s.blocked}|${s.blocked_needed_share}|${s.asks}`;
  if (rule !== current && (s.judged === 0 || sig === prev)) {
    skipped++;
    continue;
  }
  prev = sig;
  console.log(`   ${ruleName(rule)}  ${String(s.judged).padStart(5)} ${String(s.flagged).padStart(7)}      ${pct(s.flagged_unneeded_share)}          ${pct(s.unneeded_caught)}     ${String(s.blocked).padStart(5)}      ${pct(s.blocked_needed_share)}     ${String(s.asks).padStart(3)}${tag}`);
}

if (skipped) console.log(`   (${skipped} more rules not shown: nothing labelled for them yet, or the same numbers as the row above)`);

console.log("\n3. task completion (owner's answer per task)");
const tl = [...taskLabels(all).values()];
const achieved = tl.filter((x) => x === "achieved").length;
const decided = tl.filter((x) => x !== "unsure").length;
console.log(`  ${achieved} of ${decided} tasks met their purpose (${tl.length - decided} not sure). Shadow mode stopped nothing, so this is the baseline.`);

console.log("\n4. cost");
const calls = rows.filter((r) => r.jev_status === "OK" && !r.cached).length + rows.filter((r) => r.necessity_alt !== null).length;
const lat = quantiles(rows.map((r) => r.latency_ms));
console.log(`  Jev calls ~${calls} x $${JEV_USD_PER_CALL} = $${(calls * JEV_USD_PER_CALL).toFixed(5)} (price from the brief)`);
console.log(`  latency ms: ${lat ? `min ${lat.min} / median ${lat.median} / max ${lat.max}` : "-"} (in parallel with Intercepta)`);
const unneededSpend = rows.filter((r) => r.label === "unneeded").reduce((s, r) => s + Number(r.amount) / 1e6, 0);
console.log(`  spend the owner called unneeded: ${unneededSpend.toFixed(2)} USDC; owner checks added: see "asks" per rule`);
