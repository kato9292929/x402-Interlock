// Prints the first successful live call per partner, from the local records
// (data/live-checks.jsonl and data/ledger.jsonl), for FEEDBACK.md.
//   npm run first-success

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) =>
  existsSync(f)
    ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)
    : [];
const data = path.join(process.cwd(), "data");
const checks = read(path.join(data, "live-checks.jsonl"));
const ledger = read(path.join(data, "ledger.jsonl"));
const jst = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + " JST" : "(no record)";
const first = (xs: string[]) => xs.sort()[0];
const ok2xx = (s: unknown) => typeof s === "number" && s >= 200 && s < 300;

const interceptaVerify = checks.filter((c) => String(c.check).startsWith("intercepta.") && ok2xx(c.detail?.http_status)).map((c) => c.at);
const interceptaGate = ledger
  .filter((e) => e.event_type === "screening_result" && (e.data.checks ?? []).some((k: any) => ok2xx(k.http_status) && !k.cache))
  .map((e) => e.occurred_at);
const worldApproved = ledger.filter((e) => e.event_type === "human_verification" && e.data.status === "APPROVED").map((e) => e.occurred_at);
const worldRequested = ledger.filter((e) => e.event_type === "human_verification" && e.data.status === "REQUESTED").map((e) => e.occurred_at);
const paid = ledger.filter((e) => e.event_type === "payment_result" && e.data.status === "PAID");

console.log("Intercepta first 2xx (verify-live):", jst(first(interceptaVerify)));
console.log("Intercepta first 2xx (gate):       ", jst(first(interceptaGate)));
console.log("World first approval request:      ", jst(first(worldRequested)));
console.log("World first verified approval:     ", jst(first(worldApproved)));
const p = paid.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))[0];
console.log("First PAID payment:                ", jst(p?.occurred_at), p?.data.settlement?.transaction ?? "");
