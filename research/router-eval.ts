// spec/08 section 12: what does the Router's judge add over code + the cheapest price?
// 12 made-up procurement requests (one field: daily streaming stats) whose right answer follows
// from how they are built. The criterion was committed before this file (23d6052).
// Run: npx tsx --env-file-if-exists=.env.local research/router-eval.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { loadThresholds } from "../lib/appe";
import { routeCheapestOnly, routeCode, routeWithJudge, type Candidate, type Owned, type RouteChoice, type RouteRequest } from "../lib/router";

const P = { from: "2026-09-27", to: "2026-10-03" };
const FIELDS = ["date", "plays", "listeners"];
const usd = (x: number) => BigInt(Math.round(x * 1e6));
type C = Candidate & { fits: boolean };
interface Case {
  id: string;
  kind: "already_have" | "cheapest_fits" | "cheapest_wrong";
  req: RouteRequest;
  cands: C[];
  owned: Owned[];
}
const req = (artist: string): RouteRequest => ({ purpose: `Daily plays and listeners for the artist "${artist}", ${P.from} to ${P.to}`, requirements: { period: P, required_fields: FIELDS, min_items: 1 }, max_price_atomic: usd(0.1) });
const c = (id: string, price: number, description: string, fits: boolean, declared?: Candidate["declared"]): C => ({ id, url: `https://seller-${id}.example/stats`, description, price_atomic: usd(price), fits, ...(declared ? { declared } : {}) });
const have = (fields_ok = true): Owned[] => [{ decision_id: "earlier", target: "https://seller-x.example/stats", requirements: { period: P, required_fields: FIELDS, min_items: 1 }, fields_ok }];

const cases: Case[] = [
  // already obtained in this task: don't buy (3)
  { id: "have-1", kind: "already_have", req: req("Night Drive Collective"), owned: have(), cands: [c("a", 0.02, "Daily plays and listeners per artist, any period", true), c("b", 0.03, "Daily streaming stats per artist", true), c("c", 0.05, "Monthly streaming totals", false), c("d", 0.04, "Playlist placements", false)] },
  { id: "have-2", kind: "already_have", req: req("Morning Commute Band"), owned: have(), cands: [c("a", 0.01, "Daily plays and listeners per artist", true), c("b", 0.06, "Daily stats with demographics", true), c("c", 0.02, "Yearly totals per artist", false), c("d", 0.03, "Top 50 chart, daily", false)] },
  { id: "have-3", kind: "already_have", req: req("Late Train"), owned: have(), cands: [c("a", 0.04, "Daily plays and listeners per artist", true), c("b", 0.02, "Weekly plays per artist", false), c("c", 0.05, "Daily plays and listeners per artist, with country split", true), c("d", 0.03, "Radio spins per day", false)] },
  // the cheapest fits (4)
  { id: "cheap-1", kind: "cheapest_fits", req: req("Night Drive Collective"), owned: [], cands: [c("a", 0.02, "Daily plays and listeners for any artist and date range", true), c("b", 0.03, "Daily streaming stats per artist", true), c("c", 0.05, "Monthly streaming totals per artist", false), c("d", 0.04, "Daily stats for the top 50 chart artists only", false)] },
  { id: "cheap-2", kind: "cheapest_fits", req: req("Morning Commute Band"), owned: [], cands: [c("a", 0.01, "Per-artist daily plays and unique listeners", true), c("b", 0.02, "Weekly plays per artist", false), c("c", 0.04, "Daily plays and listeners per artist, country split", true), c("d", 0.12, "Daily plays and listeners per artist, premium", true)] },
  { id: "cheap-3", kind: "cheapest_fits", req: req("Late Train"), owned: [], cands: [c("a", 0.02, "Daily plays and listeners per artist", true, { period: { from: "2026-01-01", to: "2026-10-07" }, fields: FIELDS }), c("b", 0.03, "Yearly totals per artist", false), c("c", 0.05, "Radio spins per day", false), c("d", 0.03, "Daily stats per artist", true)] },
  { id: "cheap-4", kind: "cheapest_fits", req: req("Paper Moon"), owned: [], cands: [c("a", 0.03, "Daily plays and listeners per artist and day", true), c("b", 0.04, "Hourly plays per artist, last 24 hours only", false), c("c", 0.06, "Daily plays and listeners per artist", true), c("d", 0.05, "Label-level daily totals (all artists summed)", false)] },
  // the cheapest does not fit (5): one the code can see (declared period), four only the text says
  { id: "wrong-1", kind: "cheapest_wrong", req: req("Night Drive Collective"), owned: [], cands: [c("a", 0.01, "Daily plays and listeners per artist", false, { period: { from: "2025-01-01", to: "2025-12-31" } }), c("b", 0.03, "Daily plays and listeners per artist, current year", true), c("c", 0.05, "Monthly totals per artist", false), c("d", 0.04, "Daily plays and listeners, any artist", true)] },
  { id: "wrong-2", kind: "cheapest_wrong", req: req("Morning Commute Band"), owned: [], cands: [c("a", 0.01, "Monthly plays and listeners per artist", false), c("b", 0.03, "Daily plays and listeners per artist", true), c("c", 0.02, "Weekly totals per artist", false), c("d", 0.05, "Daily plays and listeners per artist with playlists", true)] },
  { id: "wrong-3", kind: "cheapest_wrong", req: req("Late Train"), owned: [], cands: [c("a", 0.01, "Daily plays for the top 50 chart artists only", false), c("b", 0.02, "Label-level daily totals, all artists summed", false), c("c", 0.04, "Daily plays and listeners for any artist", true), c("d", 0.06, "Daily per-artist plays and listeners, country split", true)] },
  { id: "wrong-4", kind: "cheapest_wrong", req: req("Paper Moon"), owned: [], cands: [c("a", 0.01, "2025 archive: daily plays and listeners per artist, January to December 2025", false), c("b", 0.03, "Daily plays and listeners per artist, updated daily", true), c("c", 0.05, "Yearly totals per artist", false), c("d", 0.04, "Radio spins per day", false)] },
  { id: "wrong-5", kind: "cheapest_wrong", req: req("Blue Hour"), owned: [], cands: [c("a", 0.01, "Daily plays per artist (listeners not included)", false), c("b", 0.02, "Daily follower count per artist", false), c("c", 0.04, "Daily plays and listeners per artist", true), c("d", 0.05, "Daily plays and listeners per artist with demographics", true)] },
];

const right = (k: Case, choice: { kind: "buy"; id: string } | { kind: "dont_buy" } | undefined) =>
  k.kind === "already_have" ? choice?.kind === "dont_buy" : choice?.kind === "buy" && k.cands.find((x) => x.id === choice.id)!.fits;
const asChoice = (r: RouteChoice) => (r.kind === "buy" ? { kind: "buy" as const, id: r.candidate.id } : { kind: "dont_buy" as const });

async function main() {
  if (cases.length !== 12 || cases.filter((k) => k.kind === "already_have").length !== 3 || cases.filter((k) => k.kind === "cheapest_fits").length !== 4) throw new Error("case counts");
  // The construction must hold before any model is asked: in "cheapest_fits" the cheapest under
  // the cap fits; in "cheapest_wrong" it does not.
  for (const k of cases.filter((x) => x.kind !== "already_have")) {
    const ch = routeCheapestOnly(k.req, k.cands) as C;
    if (ch.fits !== (k.kind === "cheapest_fits")) throw new Error(`${k.id}: built wrong (cheapest ${ch.id} fits=${ch.fits})`);
  }
  const t = loadThresholds();
  t.jev.timeout_ms = 20_000;
  const rows: { id: string; kind: Case["kind"]; A: boolean; B: boolean; C: boolean | null; choices: unknown; judge: unknown }[] = [];
  for (const k of cases) {
    const a = routeCheapestOnly(k.req, k.cands);
    const A = a ? { kind: "buy" as const, id: a.id } : { kind: "dont_buy" as const };
    const B = asChoice(routeCode(k.req, k.cands, k.owned));
    const cR = await routeWithJudge(k.req, k.cands, t, k.owned);
    const judge = "judge" in cR ? cR.judge : undefined;
    const answered = !judge || judge.status === "OK"; // already-have never asks the judge
    const C = asChoice(cR);
    rows.push({ id: k.id, kind: k.kind, A: right(k, A), B: right(k, B), C: answered ? right(k, C) : null, choices: { A, B, C }, judge: judge ?? null });
    console.log(`${k.id.padEnd(8)} ${k.kind.padEnd(15)} A ${right(k, A) ? "right" : "wrong"}  B ${right(k, B) ? "right" : "wrong"}  C ${answered ? (right(k, C) ? "right" : "wrong") : `N/A (${judge?.reason?.slice(0, 60)})`}`);
  }
  const buy = rows.filter((r) => r.kind !== "already_have");
  const n = (xs: typeof rows, m: "A" | "B" | "C") => xs.filter((r) => r[m] === true).length;
  const unanswered = rows.filter((r) => r.C === null).length;
  const cheapFits = rows.filter((r) => r.kind === "cheapest_fits");
  const have = rows.filter((r) => r.kind === "already_have");
  console.log(`\nbuy cases (9): A ${n(buy, "A")}, B ${n(buy, "B")}, C ${unanswered ? "-" : n(buy, "C")}`);
  console.log(`cheapest fits (4): C misses ${unanswered ? "-" : cheapFits.filter((r) => r.C === false).length}`);
  console.log(`already have (3): B ${n(have, "B")}, C ${n(have, "C")}`);
  const met = n(buy, "C") - n(buy, "B") >= 3 && cheapFits.filter((r) => r.C === false).length <= 1 && n(have, "B") === 3 && n(have, "C") === 3;
  const verdict = unanswered ? `NOT MEASURED (${unanswered} of 12 unanswered)` : met ? "MET" : "NOT MET";
  console.log(`criterion (spec/08 section 12): ${verdict}`);
  if (unanswered) return console.log("nothing written: rerun when the judge answers every case");
  mkdirSync("research/results", { recursive: true });
  writeFileSync("research/results/router-eval.json", JSON.stringify({ ran_at: new Date().toISOString(), criterion_commit: "23d6052", rows, verdict }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
