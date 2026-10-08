import type { LedgerEvent } from "./ledger";

// Stage 6 (spec/07 section 5-5): what earlier Delivery Reviews of the same purchase target
// observed, fed back into the next purchase. The rules here are code. They use what the code
// checks saw (HTTP status, rows, fields_ok), not the model's answers: Delivery Review's model has
// not shown it adds anything (spec/08 sections 10-11), so its verdicts are no ground to stop on.
// The model's answers are summarised for context only.

/** Origin and path: the same target whatever the query string (each demo call adds ?n=). */
export const deliveryTarget = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};

export interface DeliveryHistory {
  target: string;
  count: number;
  /** model's substance answers, for context only */
  substance: Record<string, number>;
  /** share of reviews whose code checks passed */
  fields_ok_rate: number | null;
  /** model's fulfillment, for context only */
  fulfillment_median: number | null;
  last_seen: string | null;
  /** the latest `window` reviews, newest last: what the rules look at */
  recent: { at: string; fields_ok: boolean; empty: boolean }[];
}

interface Fields {
  status_ok?: boolean;
  item_count?: number | null;
}

/** Empty by the code checks alone: an HTTP error, or no rows where rows were expected. */
const emptyByCode = (f: Fields | undefined) => f?.status_ok === false || f?.item_count === 0;

export function deliveryHistory(all: LedgerEvent[], url: string, window = 3): DeliveryHistory {
  const target = deliveryTarget(url);
  const reviews = all.filter((e) => e.event_type === "delivery_review" && deliveryTarget(String(e.data.url)) === target);
  const substance: Record<string, number> = {};
  for (const r of reviews) if (r.data.substance) substance[String(r.data.substance)] = (substance[String(r.data.substance)] ?? 0) + 1;
  const scores = reviews.map((r) => r.data.fulfillment_score).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  return {
    target,
    count: reviews.length,
    substance,
    fields_ok_rate: reviews.length ? reviews.filter((r) => r.data.fields_ok === true).length / reviews.length : null,
    fulfillment_median: scores.length ? scores[Math.floor((scores.length - 1) / 2)] : null,
    last_seen: reviews.at(-1)?.occurred_at ?? null,
    recent: reviews.slice(-window).map((r) => ({ at: r.occurred_at, fields_ok: r.data.fields_ok === true, empty: emptyByCode(r.data.fields as Fields | undefined) })),
  };
}

export type DeliveryHistoryReason = "DELIVERY_HISTORY_POOR" | "DELIVERY_HISTORY_MISMATCH";

/**
 * The stage 6 rules (owner's brief, 2026-10-08), over the latest `window` reviews of the target:
 *   empty in at least `poor_at` of them          -> DELIVERY_HISTORY_POOR
 *   fields_ok false in at least `mismatch_at`    -> DELIVERY_HISTORY_MISMATCH
 * "Empty" is the code's observation (HTTP error or 0 rows). The brief also names the model's
 * "dummy" answer; that is not used until the model is shown to add something (spec/08 section 11).
 */
export function deliveryHistoryReasons(h: DeliveryHistory, rule = { poor_at: 2, mismatch_at: 2 }): DeliveryHistoryReason[] {
  const out: DeliveryHistoryReason[] = [];
  if (h.recent.filter((r) => r.empty).length >= rule.poor_at) out.push("DELIVERY_HISTORY_POOR");
  if (h.recent.filter((r) => !r.fields_ok).length >= rule.mismatch_at) out.push("DELIVERY_HISTORY_MISMATCH");
  return out;
}
