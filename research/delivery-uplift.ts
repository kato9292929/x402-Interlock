// spec/08 section 11: what does Jev add to Delivery Review over the code checks (fields_ok)?
// 40 made-up deliveries whose ground truth follows from how they are built. The criterion was
// committed before this file existed (7bf92ee). Run: npx tsx --env-file-if-exists=.env.local research/delivery-uplift.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { checkFields, deliveryReview, type Requirements } from "../lib/delivery";
import { loadThresholds } from "../lib/appe";

const FROM = "2026-09-27";
const TO = "2026-10-03";
const DAYS = ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"];

type Truth = "good" | "bad";
type Kind = "good" | "code" | "hard";
interface Case {
  id: string;
  kind: Kind;
  what: string;
  truth: Truth;
  purpose: string;
  description: string;
  requirements: Requirements;
  status: number;
  body: unknown;
}

// Five kinds of data a buyer might ask for, each with a generator of plausible varied values.
const domains = [
  {
    key: "btc",
    purpose: `BTC/USD daily close on Coinbase, ${FROM} to ${TO}`,
    description: "BTC/USD daily OHLC from Coinbase",
    fields: ["date", "close"],
    meta: { symbol: "BTC-USD", exchange: "coinbase", interval: "1d" },
    row: (d: string, i: number) => ({ date: d, close: [61234.5, 62010.25, 61877.9, 63105.4, 62650.75, 63980.1, 64420.6][i] }),
  },
  {
    key: "weather",
    purpose: `Tokyo daily max and min temperature, ${FROM} to ${TO}`,
    description: "Daily weather history by city",
    fields: ["date", "temp_max", "temp_min"],
    meta: { city: "Tokyo", interval: "1d", unit: "celsius" },
    row: (d: string, i: number) => ({ date: d, temp_max: [27.1, 25.4, 26.8, 24.9, 23.7, 25.2, 24.1][i], temp_min: [20.3, 19.8, 21.0, 18.6, 17.9, 18.4, 17.2][i] }),
  },
  {
    key: "streams",
    purpose: `Daily plays and listeners for the artist "Night Drive Collective", ${FROM} to ${TO}`,
    description: "Daily streaming stats per artist",
    fields: ["date", "plays", "listeners"],
    meta: { artist: "Night Drive Collective", interval: "1d" },
    row: (d: string, i: number) => ({ date: d, plays: [18233, 17402, 19876, 21004, 20311, 24560, 26018][i], listeners: [6120, 5980, 6702, 7015, 6890, 8102, 8550][i] }),
  },
  {
    key: "volume",
    purpose: `ETH/USD daily traded volume (in ETH) on Coinbase, ${FROM} to ${TO}`,
    description: "Daily exchange volume by pair",
    fields: ["date", "volume"],
    meta: { symbol: "ETH-USD", exchange: "coinbase", interval: "1d", volume_unit: "ETH" },
    row: (d: string, i: number) => ({ date: d, volume: [182340.2, 171220.8, 190011.4, 205678.9, 199870.3, 214550.6, 220143.1][i] }),
  },
  {
    key: "fx",
    purpose: `USD/JPY daily closing rate, ${FROM} to ${TO}`,
    description: "Daily FX rates",
    fields: ["date", "rate"],
    meta: { pair: "USD/JPY", interval: "1d" },
    row: (d: string, i: number) => ({ date: d, rate: [148.21, 148.55, 147.93, 148.87, 149.12, 148.64, 149.4][i] }),
  },
];
type Domain = (typeof domains)[number];

const req = (d: Domain): Requirements => ({ period: { from: FROM, to: TO }, required_fields: d.fields, min_items: 1 });
const good = (d: Domain) => ({ period: { from: FROM, to: TO }, ...d.meta, items: DAYS.map((x, i) => d.row(x, i)) });
const mk = (id: string, kind: Kind, what: string, truth: Truth, d: Domain, body: unknown, status = 200): Case => ({
  id,
  kind,
  what,
  truth,
  purpose: d.purpose,
  description: d.description,
  requirements: req(d),
  status,
  body,
});
const [btc, weather, streams, volume, fx] = domains;

const cases: Case[] = [];
// 10 good: each domain twice (the second with the same data shifted, still varied and correct)
for (const d of domains) {
  cases.push(mk(`good-${d.key}-1`, "good", "correct", "good", d, good(d)));
  const g = good(d);
  g.items = g.items.slice().reverse(); // same days, other order: still a correct answer
  cases.push(mk(`good-${d.key}-2`, "good", "correct, days in reverse order", "good", d, g));
}
// 12 caught by code
for (const d of [btc, weather, streams]) cases.push(mk(`code-period-${d.key}`, "code", "wrong period (last year)", "bad", d, { ...good(d), period: { from: "2025-09-27", to: "2025-10-03" } }));
for (const d of [volume, fx, streams]) {
  const g = good(d);
  const drop = d.fields[d.fields.length - 1];
  g.items = g.items.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== drop))) as typeof g.items;
  cases.push(mk(`code-missing-${d.key}`, "code", `required field "${drop}" missing`, "bad", d, g));
}
for (const d of [btc, weather, fx]) cases.push(mk(`code-empty-${d.key}`, "code", "zero rows", "bad", d, { ...good(d), items: [] }));
for (const d of [streams, volume, btc]) cases.push(mk(`code-http-${d.key}`, "code", "HTTP 500 with an error body", "bad", d, { error: "upstream timeout" }, 500));

// 18 that pass the code checks
// wrong entity (4)
cases.push(mk("hard-entity-btc", "hard", "ETH data instead of BTC", "bad", btc, { ...good(btc), symbol: "ETH-USD", items: DAYS.map((x, i) => ({ date: x, close: [2410.5, 2388.2, 2455.9, 2502.3, 2478.6, 2530.1, 2561.4][i] })) }));
cases.push(mk("hard-entity-weather", "hard", "Osaka instead of Tokyo", "bad", weather, { ...good(weather), city: "Osaka" }));
cases.push(mk("hard-entity-volume", "hard", "Binance volume instead of Coinbase", "bad", volume, { ...good(volume), exchange: "binance" }));
cases.push(mk("hard-entity-streams", "hard", "another artist", "bad", streams, { ...good(streams), artist: "Morning Commute Band" }));
// wrong granularity (4)
cases.push(mk("hard-gran-btc-monthly", "hard", "one monthly row instead of daily", "bad", btc, { ...good(btc), interval: "1M", items: [{ date: "2026-09", close: 63105.4 }] }));
cases.push(mk("hard-gran-fx-weekly", "hard", "one weekly row instead of daily", "bad", fx, { ...good(fx), interval: "1w", items: [{ date: "2026-09-27", rate: 148.6 }] }));
cases.push(mk("hard-gran-weather-hourly", "hard", "hourly rows for the first day only", "bad", weather, { ...good(weather), interval: "1h", items: Array.from({ length: 24 }, (_, h) => ({ date: `2026-09-27T${String(h).padStart(2, "0")}:00Z`, temp_max: 20 + (h % 7), temp_min: 19 + (h % 5) })) }));
cases.push(mk("hard-gran-streams-yearly", "hard", "one yearly total instead of daily", "bad", streams, { ...good(streams), interval: "1y", items: [{ date: "2026", plays: 5123004, listeners: 401220 }] }));
// different definition (3)
cases.push(mk("hard-def-volume", "hard", "volume counted in trades, not ETH", "bad", volume, { ...good(volume), volume_unit: "number of trades", note: "volume is the number of trades executed, not the traded amount", items: DAYS.map((x, i) => ({ date: x, volume: [91234, 88710, 95002, 99871, 97120, 103455, 108230][i] })) }));
cases.push(mk("hard-def-btc", "hard", "close is the 00:00 UTC open, not the close", "bad", btc, { ...good(btc), note: "close here is the opening price at 00:00 UTC of each day" }));
cases.push(mk("hard-def-streams", "hard", "plays are unique listeners, listeners are followers", "bad", streams, { ...good(streams), note: "plays counts unique listeners per day; listeners counts total followers" }));
// plausible fabrication (4)
cases.push(mk("hard-fake-btc-const", "hard", "the same close every day", "bad", btc, { ...good(btc), items: DAYS.map((x) => ({ date: x, close: 60000 })) }));
cases.push(mk("hard-fake-fx-seq", "hard", "rates 100, 101, 102 ...", "bad", fx, { ...good(fx), items: DAYS.map((x, i) => ({ date: x, rate: 100 + i })) }));
cases.push(mk("hard-fake-weather-const", "hard", "20.0 / 10.0 every day", "bad", weather, { ...good(weather), items: DAYS.map((x) => ({ date: x, temp_max: 20.0, temp_min: 10.0 })) }));
cases.push(mk("hard-fake-streams-round", "hard", "1000 plays and 100 listeners every day", "bad", streams, { ...good(streams), items: DAYS.map((x) => ({ date: x, plays: 1000, listeners: 100 })) }));
// partly missing (3)
cases.push(mk("hard-partial-fx-4", "hard", "4 of 7 days", "bad", fx, { ...good(fx), items: good(fx).items.filter((_, i) => [0, 1, 4, 6].includes(i)) }));
cases.push(mk("hard-partial-volume-3", "hard", "3 of 7 days", "bad", volume, { ...good(volume), items: good(volume).items.slice(0, 3) }));
cases.push(mk("hard-partial-weather-5", "hard", "5 of 7 days", "bad", weather, { ...good(weather), items: good(weather).items.filter((_, i) => i !== 2 && i !== 5) }));

// The construction must hold before any model is asked.
const counts = { good: 0, code: 0, hard: 0 };
for (const c of cases) {
  counts[c.kind]++;
  const f = checkFields(c.status, JSON.stringify(c.body), c.requirements);
  const expectOk = c.kind !== "code";
  if (f.fields_ok !== expectOk) throw new Error(`${c.id}: fields_ok ${f.fields_ok}, built to be ${expectOk}`);
}
if (cases.length !== 40 || counts.good !== 10 || counts.code !== 12 || counts.hard !== 18) throw new Error(`case counts ${JSON.stringify(counts)}`);
console.log(`40 cases built (good 10, code-catchable 12, pass the code checks 18); fields_ok matches the construction for all`);

async function main() {
const t = loadThresholds();
t.jev.timeout_ms = 20_000; // offline measurement, not the gate's limit
t.jev.cache_minutes = 0;
const rows: Record<string, unknown>[] = [];
for (const c of cases) {
  const text = JSON.stringify(c.body);
  const r = await deliveryReview({ purpose: c.purpose, agent_purpose: c.purpose, requirements: c.requirements, description: c.description, status: c.status, text, latency_ms: 300 }, t);
  const codeBad = !r.fields_ok;
  const jevAnswered = r.jev_status === "OK";
  const jevBad = jevAnswered && ((r.answers_prob ?? 1) < 0.5 || ["empty", "dummy_or_fixed", "error_text"].includes(String(r.substance)) || (r.fulfillment_score ?? 9) < 5);
  rows.push({ id: c.id, kind: c.kind, what: c.what, truth: c.truth, codeBad, jevAnswered, jevBad, answers: r.answers_prob, substance: r.substance, fulfillment: r.fulfillment_score, model: r.jev_model, reason: r.jev_reason });
  console.log(
    `${c.id.padEnd(26)} ${c.truth.padEnd(4)} code ${codeBad ? "BAD " : "ok  "} jev ${jevAnswered ? (jevBad ? "BAD " : "ok  ") : "N/A "} answers ${r.answers_prob ?? "-"} substance ${r.substance ?? "-"} fulfillment ${r.fulfillment_score ?? "-"}${jevAnswered ? "" : ` (${r.jev_reason})`}`,
  );
}

const of = (k: Kind) => rows.filter((r) => r.kind === k);
const hard = of("hard");
const codeHard = hard.filter((r) => r.codeBad).length;
const bothHard = hard.filter((r) => r.codeBad || r.jevBad).length;
const goodFalse = of("good").filter((r) => r.codeBad || r.jevBad).length;
const codeCaught = of("code").filter((r) => r.codeBad || r.jevBad).length;
const unanswered = rows.filter((r) => !r.jevAnswered).length;
const uplift = bothHard - codeHard;
const met = uplift >= 9 && goodFalse <= 1;
  // A case Jev did not answer is not a "no": the measurement is incomplete, and is reported so.
  const verdict = unanswered ? `NOT MEASURED (${unanswered} of 40 unanswered)` : met ? "MET" : "NOT MET";
console.log(`\nhard (pass the code checks), 18: code alone ${codeHard}, code + Jev ${bothHard} -> uplift ${uplift} (bar: >= 9)`);
console.log(`good, 10: flagged bad by code + Jev ${goodFalse} (bar: <= 1)`);
console.log(`code-catchable, 12: caught ${codeCaught}`);
console.log(`Jev unanswered: ${unanswered} of 40`);
console.log(`criterion (spec/08 section 11): ${verdict}`);
  if (unanswered) {
    console.log("nothing written: rerun when every case is answered");
    return;
  }
mkdirSync("research/results", { recursive: true });
writeFileSync("research/results/delivery-uplift.json", JSON.stringify({ ran_at: new Date().toISOString(), criterion_commit: "7bf92ee", rows, summary: { codeHard, bothHard, uplift, goodFalse, codeCaught, unanswered, met, verdict } }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
