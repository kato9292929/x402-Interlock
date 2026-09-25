import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type LedgerEventType =
  | "payment_candidate"
  | "screening_result"
  | "gate_decision"
  | "human_verification"
  | "payment_result";

export interface LedgerEvent {
  event_id: string;
  decision_id: string;
  event_type: LedgerEventType;
  occurred_at: string;
  data: Record<string, unknown>;
  previous_event_hash: string | null;
  event_hash: string;
}

// Anything that looks like a credential never reaches the ledger.
const SECRET_KEY = /(api[-_]?key|secret|private|authorization|signature|password|token_value|x-api-key)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        SECRET_KEY.test(k) ? [k, "[redacted]"] : [k, redact(v)],
      ),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** JSON with sorted keys, so the hash does not depend on insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashEvent(e: Omit<LedgerEvent, "event_hash">): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

export class Ledger {
  constructor(readonly file = process.env.LEDGER_PATH ?? path.join(process.cwd(), "data", "ledger.jsonl")) {}

  readAll(): LedgerEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEvent);
  }

  /** Append-only. Existing lines are never rewritten. Sync I/O keeps appends ordered within one process. */
  append(decision_id: string, event_type: LedgerEventType, data: Record<string, unknown>): LedgerEvent {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const all = this.readAll();
    const prev = all.length ? all[all.length - 1].event_hash : null;
    const base = {
      event_id: randomUUID(),
      decision_id,
      event_type,
      occurred_at: new Date().toISOString(),
      data: redact(data) as Record<string, unknown>,
      previous_event_hash: prev,
    };
    const event: LedgerEvent = { ...base, event_hash: hashEvent(base) };
    appendFileSync(this.file, JSON.stringify(event) + "\n");
    return event;
  }

  /** Returns the index of the first broken line, or -1 if the chain is intact. */
  verify(): number {
    const all = this.readAll();
    let prev: string | null = null;
    for (let i = 0; i < all.length; i++) {
      const { event_hash, ...rest } = all[i];
      if (rest.previous_event_hash !== prev || hashEvent(rest) !== event_hash) return i;
      prev = event_hash;
    }
    return -1;
  }

  byDecision(decision_id: string): LedgerEvent[] {
    return this.readAll().filter((e) => e.decision_id === decision_id);
  }
}
