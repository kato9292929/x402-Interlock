import type { LedgerEvent } from "./ledger";

// The spec/07 section 4 check: Spend Guard's shadow reviews against the owner's own judgement.
// Pure functions over ledger events, so scripts/appe-label.ts and scripts/appe-metrics.ts stay thin.

export type PurchaseLabel = "needed" | "unneeded" | "unsure";
export type TaskLabel = "achieved" | "not_achieved" | "unsure";

export interface ReviewRow {
  decision_id: string;
  task_id: string;
  at: string;
  url: string;
  amount: string;
  description: string | null;
  jev_status: string;
  necessity: number | null;
  necessity_alt: number | null;
  duplicate: number | null;
  nature: string | null;
  would_have: string;
  latency_ms: number;
  cached: boolean;
  label?: PurchaseLabel;
}

/** Labels count only after the latest owner_label_reset: the ledger is append-only, so a set of
 * labels the owner withdraws is closed off by a reset event instead of being deleted. */
function afterReset(events: LedgerEvent[]): LedgerEvent[] {
  let last = -1;
  events.forEach((e, i) => {
    if (e.event_type === "owner_label_reset") last = i;
  });
  return events.slice(last + 1);
}

/** Every Spend Guard shadow review, oldest first, with the owner's label if there is one. */
export function reviewRows(events: LedgerEvent[]): ReviewRow[] {
  const labels = new Map<string, PurchaseLabel>();
  for (const e of afterReset(events)) if (e.event_type === "owner_label") labels.set(String(e.data.target_decision_id), e.data.label as PurchaseLabel);
  return events
    .filter((e) => e.event_type === "spend_guard_review" && e.data.mode === "shadow")
    .map((e) => {
      const d = e.data;
      return {
        decision_id: e.decision_id,
        task_id: String(d.task_id),
        at: e.occurred_at,
        url: String(d.url),
        amount: String(d.amount),
        description: (d.candidate_description as string | null | undefined) ?? null,
        jev_status: String(d.jev_status),
        necessity: (d.necessity_prob as number | null) ?? null,
        necessity_alt: (d.necessity_alt_prob as number | null | undefined) ?? null,
        duplicate: (d.duplicate_prob as number | null) ?? null,
        nature: (d.nature as string | null) ?? null,
        would_have: String(d.would_have),
        latency_ms: Number(d.latency_ms ?? 0),
        cached: d.cached === true,
        label: labels.get(e.decision_id),
      };
    });
}

export function taskLabels(events: LedgerEvent[]): Map<string, TaskLabel> {
  const m = new Map<string, TaskLabel>();
  for (const e of afterReset(events)) if (e.event_type === "owner_task_label") m.set(String(e.data.task_id), e.data.label as TaskLabel);
  return m;
}

export interface Rule {
  wording: "necessary" | "necessary_or_useful";
  /** necessity below this -> block */
  block: number;
  /** necessity below this (and not blocked) -> ask_human */
  ask: number;
  /** duplicate at or above this -> ask_human */
  duplicate_ask: number;
  /** nature "unrelated" -> block */
  nature_blocks: boolean;
}

/** What a rule would have done with one review; null when Jev did not answer. */
export function decide(r: ReviewRow, rule: Rule): "none" | "ask_human" | "block" | null {
  const nec = rule.wording === "necessary" ? r.necessity : r.necessity_alt;
  if (r.jev_status !== "OK" || nec === null || r.duplicate === null) return null;
  if (nec < rule.block || (rule.nature_blocks && r.nature === "unrelated")) return "block";
  if (nec < rule.ask || r.duplicate >= rule.duplicate_ask) return "ask_human";
  return "none";
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export interface RuleStats {
  rule: Rule;
  judged: number;
  flagged: number;
  /** section 4 metric 1: of flagged (ask or block), the share the owner called unneeded */
  flagged_unneeded_share: number | null;
  /** of all purchases the owner called unneeded, the share flagged */
  unneeded_caught: number | null;
  blocked: number;
  /** section 4 metric 2: of blocked, the share the owner called needed (lower is better) */
  blocked_needed_share: number | null;
  /** extra owner checks this rule would add: purchases it sends to ask_human */
  asks: number;
}

/** Score one rule against the owner's labels. "unsure" labels and unanswered reviews are left out. */
export function scoreRule(rows: ReviewRow[], rule: Rule): RuleStats {
  const labelled = rows.filter((r) => r.label === "needed" || r.label === "unneeded");
  let flagged = 0, flaggedUnneeded = 0, blocked = 0, blockedNeeded = 0, unneeded = 0, unneededFlagged = 0, asks = 0, judged = 0;
  for (const r of labelled) {
    const d = decide(r, rule);
    if (d === null) continue;
    judged++;
    if (r.label === "unneeded") unneeded++;
    if (d !== "none") {
      flagged++;
      if (r.label === "unneeded") (flaggedUnneeded++, unneededFlagged++);
    }
    if (d === "block") {
      blocked++;
      if (r.label === "needed") blockedNeeded++;
    }
    if (d === "ask_human") asks++;
  }
  return {
    rule,
    judged,
    flagged,
    flagged_unneeded_share: ratio(flaggedUnneeded, flagged),
    unneeded_caught: ratio(unneededFlagged, unneeded),
    blocked,
    blocked_needed_share: ratio(blockedNeeded, blocked),
    asks,
  };
}

/** The candidate rules compared in the section 4 table: both wordings, a range of thresholds. */
export function candidateRules(dupAsk: number): Rule[] {
  const out: Rule[] = [];
  for (const wording of ["necessary", "necessary_or_useful"] as const)
    for (const nature_blocks of [true, false])
      for (const block of [0, 0.05, 0.1, 0.2, 0.3, 0.4])
        for (const ask of [0.5, 0.75]) if (ask > block) out.push({ wording, block, ask, duplicate_ask: dupAsk, nature_blocks });
  return out;
}

export function quantiles(xs: number[]): { n: number; min: number; median: number; max: number } | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1] };
}

/** Enough to decide on? The brief: at least 30, with needed and unneeded both present. */
export function readiness(rows: ReviewRow[]): { needed: number; unneeded: number; unsure: number; unlabelled: number; ready: boolean } {
  const c = { needed: 0, unneeded: 0, unsure: 0, unlabelled: 0 };
  for (const r of rows) c[r.label ?? "unlabelled"]++;
  return { ...c, ready: c.needed + c.unneeded >= 30 && c.needed > 0 && c.unneeded > 0 };
}
