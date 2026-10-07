// spec/08 section 10: the fixed-rule baseline for Spend Guard. Does a keyword rule catch the same
// not-needed purchases as the judge model, with no model at all?
//
// The rules were fixed before scoring (2026-10-07), but after the items had been seen during the
// earlier work, so they are not blind to the data. Neither uses a synonym list or anything built
// from these items:
//   K1  ask when the task purpose and the item (slug + seller description) share no content word
//   K2  the same, with the item slug only (no seller text)
// Content word: lower case, split on anything not a letter or digit, words of 3 letters or more,
// not in a generic English stopword list, not a number, one trailing "s" removed.
//
// Two views:
//   config   the scenario purchases rebuilt from config (appe-eval-scenarios, eval-catalog,
//            prices, appe-labels) plus the earlier runs' known purchases: no ledger needed
//   ledger   every Spend Guard review in the ledger, with its own label, next to the judge's
//            answer on the same purchase (the validated rule: "necessary or useful" < 0.50 or
//            nature unrelated), when a ledger with reviews is present
// Run: npm run appe-keyword-baseline
import { readFileSync } from "node:fs";
import { Ledger } from "../lib/ledger";
import { itemOf, reviewRows, sellerDescription, type PurchaseLabel, type RuleLabelFile } from "../lib/appe-eval";
import { getTask } from "../lib/tasks";

const STOP = new Set(
  `a an and are as at be by for from in into is it its of on or the to with this that these those
which what who whom right now about up down over under per one two three new latest current most more
make prepare answer book translate weekly daily including user users question q3 2026 30 second`.split(/\s+/),
);

export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w);
  }
  return out;
}
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w));
const k1 = (purpose: string, item: string, description: string | null) => overlap(contentWords(purpose), new Set([...contentWords(item.replace(/-/g, " ")), ...contentWords(description ?? "")])).length === 0;
const k2 = (purpose: string, item: string) => overlap(contentWords(purpose), contentWords(item.replace(/-/g, " "))).length === 0;

const json = <T>(f: string) => JSON.parse(readFileSync(f, "utf8")) as T;
const catalog = json<{ items: Record<string, { description: string }> }>("config/eval-catalog.json").items;
const prices = json<{ routes: Record<string, { description: string }> }>("config/prices.json").routes;
const table = json<RuleLabelFile>("config/appe-labels.json");
const describe = (item: string) => catalog[item]?.description ?? prices[item]?.description ?? null;

function tableLabel(purpose: string, item: string): PurchaseLabel | undefined {
  for (const g of Object.values(table.groups)) {
    if (!g.purpose_contains.some((p) => purpose.toLowerCase().includes(p.toLowerCase()))) continue;
    return (["needed", "unneeded", "unsure"] as const).find((l) => (g[l] ?? []).includes(item));
  }
  return undefined;
}

interface Row {
  purpose: string;
  item: string;
  label: PurchaseLabel;
  flags: Record<string, boolean | null>;
}

function report(title: string, rows: Row[], methods: string[]) {
  console.log(`\n${title}: ${rows.length} purchases (needed ${rows.filter((r) => r.label === "needed").length}, not needed ${rows.filter((r) => r.label === "unneeded").length}, unsure ${rows.filter((r) => r.label === "unsure").length})`);
  console.log("  method                                   not needed caught   needed stopped   flagged -> not needed");
  for (const m of methods) {
    const judged = rows.filter((r) => r.flags[m] !== null && r.label !== "unsure");
    const un = judged.filter((r) => r.label === "unneeded");
    const ne = judged.filter((r) => r.label === "needed");
    const caught = un.filter((r) => r.flags[m]).length;
    const stopped = ne.filter((r) => r.flags[m]).length;
    const flagged = caught + stopped;
    console.log(`  ${m.padEnd(40)} ${`${caught} / ${un.length}`.padStart(9)} (${un.length ? Math.round((caught / un.length) * 100) : 0}%)   ${`${stopped} / ${ne.length}`.padStart(9)}      ${flagged ? `${Math.round((caught / flagged) * 100)}%` : "-"}`);
  }
  for (const m of methods) {
    const missed = rows.filter((r) => r.label === "unneeded" && r.flags[m] === false).map((r) => `${r.item} (${r.purpose.slice(0, 24)})`);
    console.log(`  ${m}: missed ${missed.length ? missed.join(", ") : "none"}`);
  }
}

const K1 = "K1 keyword: purpose x item + description";
const K2 = "K2 keyword: purpose x item name only";
const JEV = "judge model (validated rule)";

// View 1: from config, no ledger needed.
const scenarios = json<{ tasks: { purpose: string; buy: string[] }[] }>("config/appe-eval-scenarios.json").tasks;
const known: [string, string][] = [
  ...scenarios.flatMap((t) => t.buy.map((i) => [t.purpose, i] as [string, string])),
  // earlier devnet runs whose purchases are fixed by their scripts
  ["Make one music video", "sol-clip"],
  ["Make one music video", "sol-clip"],
  ["Prepare the quarterly tax filing", "sol-clip"],
  ...["sol-stats", "sol-stats-stale", "sol-stats-empty"].map((i) => ["Weekly streaming report for the artist, 2026-09-27 to 2026-10-03", i] as [string, string]),
];
const fromConfig: Row[] = known.map(([purpose, item]) => ({
  purpose,
  item,
  label: tableLabel(purpose, item)!,
  flags: { [K1]: k1(purpose, item, describe(item)), [K2]: k2(purpose, item) },
}));
report("from config (scenarios and earlier runs, labels from config/appe-labels.json)", fromConfig, [K1, K2]);

// View 2: the ledger's own reviews and labels, judge and keywords on the same purchases.
const rows = reviewRows(new Ledger().readAll()).filter((r) => r.label);
if (rows.length) {
  const fromLedger: Row[] = rows.map((r) => {
    const purpose = getTask(r.task_id)?.purpose ?? "";
    const item = itemOf(r.url);
    const judged = r.jev_status === "OK" && r.necessity_alt !== null;
    return {
      purpose,
      item,
      label: r.label!,
      flags: {
        [K1]: k1(purpose, item, sellerDescription(r.url, r.description)),
        [K2]: k2(purpose, item),
        [JEV]: judged ? r.necessity_alt! < 0.5 || r.nature === "unrelated" : null,
      },
    };
  });
  report("from the ledger (the same purchases for every method)", fromLedger, [K1, K2, JEV]);
} else {
  console.log("\n(no labelled reviews in this ledger: the side-by-side view with the judge model needs the owner's ledger)");
}
