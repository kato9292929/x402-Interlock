import type { LedgerEvent } from "./ledger";

// Stage 8 (spec/07 section 8): what a task's other payments hold, read from the ledger.
// Pure functions; lib/gate.ts calls them under the ledger lock.

/** A reservation still counts while its decision has no result, for at most this long. */
export const BUDGET_HOLD_MS = 15 * 60_000;

const resultOf = (own: LedgerEvent[]) => own.filter((e) => e.event_type === "payment_result").at(-1);
const humanOpen = (own: LedgerEvent[]) => {
  const h = own.filter((e) => e.event_type === "human_verification");
  return h.length > 0 && !h.some((e) => ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"].includes(String(e.data.status)));
};

/**
 * Budget held by the task's other payments that are decided but not finished (atomic units).
 * A payment holds its amount from evaluate until its payment_result, so two agents in one task
 * cannot both pass on the same remaining budget. One waiting for the owner keeps holding; one
 * with no result after BUDGET_HOLD_MS (a crashed request) stops holding.
 */
export function budgetReservedAtomic(all: LedgerEvent[], task_id: string, except: string, now = Date.now()): bigint {
  let sum = 0n;
  for (const r of all) {
    if (r.event_type !== "budget_reserved" || r.data.task_id !== task_id || r.decision_id === except) continue;
    const own = all.filter((e) => e.decision_id === r.decision_id);
    if (resultOf(own)) continue;
    if (now - Date.parse(r.occurred_at) > BUDGET_HOLD_MS && !humanOpen(own)) continue;
    sum += BigInt(String(r.data.amount));
  }
  return sum;
}

/** Payment results whose outcome is unknown until the chain is checked (see lib/gate.ts). */
export const OUTCOME_UNKNOWN = new Set(["ALLOWANCE_PULL_UNCONFIRMED", "SELLER_NO_RESPONSE"]);

/** Decisions in this task whose payment outcome is still unknown (not released, not reconciled). */
export function unconfirmedInTask(all: LedgerEvent[], task_id: string): string[] {
  const out: string[] = [];
  for (const r of all) {
    if (r.event_type !== "payment_reserved" || r.data.task_id !== task_id) continue;
    const own = all.filter((e) => e.decision_id === r.decision_id);
    if (own.some((e) => e.event_type === "payment_reservation_released" || e.event_type === "payment_reconciled")) continue;
    const res = resultOf(own);
    if (res && res.data.status === "PAYMENT_FAILED" && OUTCOME_UNKNOWN.has(String(res.data.reason))) out.push(r.decision_id);
  }
  return out;
}

/**
 * Payment failures in a row for this task, newest first, since the owner last resumed it.
 * Only attempts that reached the money count (PAID or PAYMENT_FAILED); a blocked decision is not
 * a failure of payment.
 */
export function consecutiveFailures(all: LedgerEvent[], task_id: string): number {
  let since = -1;
  all.forEach((e, i) => {
    if (e.event_type === "task_resumed" && e.data.task_id === task_id) since = i;
  });
  const attempts = all.slice(since + 1).filter((e) => e.event_type === "payment_result" && e.data.task_id === task_id && (e.data.status === "PAID" || e.data.status === "PAYMENT_FAILED"));
  let n = 0;
  for (let i = attempts.length - 1; i >= 0 && attempts[i].data.status === "PAYMENT_FAILED"; i--) n++;
  return n;
}
