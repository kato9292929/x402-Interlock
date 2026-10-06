import { readFileSync } from "node:fs";
import path from "node:path";
import type { LedgerEvent } from "./ledger";
import { toAtomic } from "./amount";
import type { SpendGuardInput } from "./appe";

// The spec/07 section 4 check: Spend Guard's shadow reviews against the owner's own judgement.
// Pure functions over ledger events, so scripts/appe-label.ts and scripts/appe-metrics.ts stay thin.

export type PurchaseLabel = "needed" | "unneeded" | "unsure";
export type TaskLabel = "achieved" | "not_achieved" | "unsure";

/** One judge's answers on one purchase: the live review, or a section 4 replay by a provider. */
export interface Judged {
  status: string;
  model: string | null;
  necessity: number | null;
  necessity_alt: number | null;
  duplicate: number | null;
  nature: string | null;
  latency_ms: number;
}

export interface ReviewRow {
  decision_id: string;
  /** the provider that answered live in the gate ("typesafe" for reviews from before the switch) */
  provider: string;
  /** the latest replay per provider (npm run appe-compare), on the rebuilt state */
  replays: Record<string, Judged>;
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
  /** "owner": pressed one by one (owner_label). "rule": applied from a table where the answer
   * follows from how the purchase was built (rule_label, spec/08). An owner label always wins. */
  label_source?: "owner" | "rule";
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
  const ruled = new Map<string, PurchaseLabel>();
  for (const e of afterReset(events)) {
    if (e.event_type === "owner_label") labels.set(String(e.data.target_decision_id), e.data.label as PurchaseLabel);
    if (e.event_type === "rule_label") ruled.set(String(e.data.target_decision_id), e.data.label as PurchaseLabel);
  }
  const replays = new Map<string, Record<string, Judged>>();
  for (const e of events) {
    if (e.event_type !== "spend_guard_replay") continue;
    const d = e.data;
    const m = replays.get(String(d.target_decision_id)) ?? {};
    m[String(d.provider)] = {
      status: String(d.status),
      model: (d.model as string | null) ?? null,
      necessity: (d.necessity_prob as number | null) ?? null,
      necessity_alt: (d.necessity_alt_prob as number | null) ?? null,
      duplicate: (d.duplicate_prob as number | null) ?? null,
      nature: (d.nature as string | null) ?? null,
      latency_ms: Number(d.latency_ms ?? 0),
    };
    replays.set(String(d.target_decision_id), m);
  }
  return events
    .filter((e) => e.event_type === "spend_guard_review" && e.data.mode === "shadow")
    .map((e) => {
      const d = e.data;
      return {
        decision_id: e.decision_id,
        provider: (d.jev_provider as string | undefined) ?? "typesafe",
        replays: replays.get(e.decision_id) ?? {},
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
        label: labels.get(e.decision_id) ?? ruled.get(e.decision_id),
        label_source: labels.has(e.decision_id) ? ("owner" as const) : ruled.has(e.decision_id) ? ("rule" as const) : undefined,
      };
    });
}

/**
 * The rows as one judge saw them: "live" is the answer recorded in the gate; a provider name is
 * that provider's replay (npm run appe-compare). A purchase with no replay by that provider has
 * status NOT_REPLAYED and is left out of every metric, like an UNAVAILABLE one.
 */
export function judgedBy(rows: ReviewRow[], source: string): ReviewRow[] {
  if (source === "live") return rows;
  return rows.map((r) => {
    const j = r.replays[source];
    return {
      ...r,
      jev_status: j?.status ?? "NOT_REPLAYED",
      necessity: j?.necessity ?? null,
      necessity_alt: j?.necessity_alt ?? null,
      duplicate: j?.duplicate ?? null,
      nature: j?.nature ?? null,
      latency_ms: j?.latency_ms ?? 0,
      cached: false,
    };
  });
}

/** Every judge with answers in the ledger: "live" plus each provider that replayed. */
export const sources = (rows: ReviewRow[]) => ["live", ...new Set(rows.flatMap((r) => Object.keys(r.replays)))];

/**
 * The boundary for owner labelling (spec/07 section 4, 2026-10-05): "necessary or useful"
 * between 0.30 and 0.85. Purchases outside it are skipped: they are not labelled automatically
 * and they are left out of the metrics (npm run appe-metrics -- --boundary).
 */
export const BOUNDARY = { low: 0.3, high: 0.85 } as const;
export type BoundaryClass = "boundary" | "above" | "below" | "no_value";

/**
 * Where a purchase falls, over every judge that answered it (live and replays): inside the range
 * for any judge -> boundary. Judges on opposite sides of it (one above, one below) also count as
 * boundary, since they disagree. Selecting by one judge alone would compare the others only on
 * the purchases that judge found hard.
 */
export function boundaryOf(r: ReviewRow, b: { low: number; high: number } = BOUNDARY): BoundaryClass {
  const vals = [r.jev_status === "OK" ? r.necessity_alt : null, ...Object.values(r.replays).map((j) => (j.status === "OK" ? j.necessity_alt : null))].filter(
    (x): x is number => x !== null,
  );
  if (!vals.length) return "no_value";
  if (vals.some((v) => v >= b.low && v <= b.high)) return "boundary";
  if (vals.every((v) => v > b.high)) return "above";
  if (vals.every((v) => v < b.low)) return "below";
  return "boundary";
}

/** The seller's description: recorded with the review, or (older reviews, or one cut at 200
 * characters) from the demo seller config, which is what the seller served. */
export function sellerDescription(url: string, recorded: string | null, root = process.cwd()): string | null {
  if (recorded && recorded.length < 200) return recorded;
  try {
    const p = new URL(url).pathname;
    const cat = /^\/api\/seller\/sol-catalog\/([a-z0-9-]+)$/.exec(p);
    if (cat) return (JSON.parse(readFileSync(path.join(root, "config/eval-catalog.json"), "utf8")) as { items: Record<string, { description: string }> }).items[cat[1]]?.description ?? recorded;
    const name = /^\/api\/seller\/([a-z0-9-]+)$/.exec(p)?.[1];
    const routes = (JSON.parse(readFileSync(path.join(root, "config/prices.json"), "utf8")) as { routes: Record<string, { description: string }> }).routes;
    return name && routes[name] ? routes[name].description : recorded;
  } catch {
    return recorded;
  }
}

/**
 * Rebuild the Spend Guard input of a past review from the ledger, for a replay: the task, the
 * candidate, and the ledger as it stood before that purchase (its history). The state the judge
 * sees is then spendGuardState(input); its hash is compared with the one the live review kept.
 */
export function replayInput(
  all: LedgerEvent[],
  decision_id: string,
  deps: { task: (id: string) => { task_id: string; purpose: string; budget: { amount: string } } | null; decimals: number },
): SpendGuardInput | { error: string } {
  const at = all.findIndex((e) => e.decision_id === decision_id);
  const review = all.find((e) => e.decision_id === decision_id && e.event_type === "spend_guard_review");
  if (at < 0 || !review) return { error: "no spend_guard_review" };
  const d = review.data;
  const task = deps.task(String(d.task_id));
  if (!task) return { error: `task ${String(d.task_id)} not found` };
  return {
    task: { task_id: task.task_id, purpose: task.purpose, budget_atomic: toAtomic(task.budget.amount, deps.decimals) },
    candidate: { url: String(d.url), description: sellerDescription(String(d.url), (d.candidate_description as string | null | undefined) ?? null), amount_atomic: BigInt(String(d.amount)) },
    ledger: all.slice(0, at),
    decimals: deps.decimals,
  };
}

// ---------------------------------------------------------------------------
// labels by construction (spec/08: "a label whose answer follows from how the case was built")
// ---------------------------------------------------------------------------

/**
 * A table of labels by task group and item. A purchase's group is found from its task's purpose
 * (case-insensitive substring); its item is the seller path (`clip-city-night`, `sol-stats`).
 * Repeats get the same label as the first purchase: the label is about the item, and repeats
 * are the duplicate question's business.
 */
export interface RuleLabelFile {
  /** why these labels follow from how the purchases were built; recorded in the ledger */
  basis: string;
  groups: Record<string, { purpose_contains: string[]; needed?: string[]; unneeded?: string[]; unsure?: string[] }>;
  /** the answer for every task's "purpose met?" question, if the table gives one */
  task_label?: TaskLabel;
}

/** The seller item of a purchase URL: the path after /api/seller/ (and sol-catalog/). */
export const itemOf = (url: string) => new URL(url).pathname.replace(/^\/api\/seller\/(sol-catalog\/)?/, "");

export function checkRuleFile(f: RuleLabelFile): string[] {
  const problems: string[] = [];
  if (!f.basis?.trim()) problems.push("basis is empty: say why these labels follow from how the purchases were built");
  if (!f.groups || !Object.keys(f.groups).length) problems.push("no groups");
  for (const [name, g] of Object.entries(f.groups ?? {})) {
    if (!g.purpose_contains?.length) problems.push(`${name}: purpose_contains is empty`);
    const seen = new Map<string, string>();
    for (const label of ["needed", "unneeded", "unsure"] as const)
      for (const item of g[label] ?? []) {
        if (seen.has(item)) problems.push(`${name}: ${item} is both ${seen.get(item)} and ${label}`);
        seen.set(item, label);
      }
  }
  if (f.task_label && !["achieved", "not_achieved", "unsure"].includes(f.task_label)) problems.push(`task_label ${f.task_label} is not achieved, not_achieved or unsure`);
  return problems;
}

export interface RulePlan {
  /** to append as rule_label */
  apply: { row: ReviewRow; label: PurchaseLabel; group: string; item: string }[];
  /** already labelled the same way (by the owner or by an earlier run of the table) */
  same: ReviewRow[];
  /** the owner pressed a different label: kept, listed for the owner to look at */
  conflicts: { row: ReviewRow; owner: PurchaseLabel; table: PurchaseLabel; group: string; item: string }[];
  /** no group for the task, more than one group, or the item is not in the group's lists */
  unmatched: { row: ReviewRow; why: string }[];
}

export function planRuleLabels(rows: ReviewRow[], f: RuleLabelFile, purposeOf: (task_id: string) => string | undefined): RulePlan {
  const plan: RulePlan = { apply: [], same: [], conflicts: [], unmatched: [] };
  for (const row of rows) {
    const purpose = (purposeOf(row.task_id) ?? "").toLowerCase();
    const groups = Object.entries(f.groups).filter(([, g]) => g.purpose_contains.some((p) => purpose.includes(p.toLowerCase())));
    if (groups.length !== 1) {
      plan.unmatched.push({ row, why: groups.length ? `task matches ${groups.map(([n]) => n).join(" and ")}` : "task matches no group" });
      continue;
    }
    const [group, g] = groups[0];
    const item = itemOf(row.url);
    const label = (["needed", "unneeded", "unsure"] as const).find((l) => (g[l] ?? []).includes(item));
    if (!label) {
      plan.unmatched.push({ row, why: `${item} is not listed for ${group}` });
      continue;
    }
    if (row.label === label) plan.same.push(row);
    else if (row.label_source === "owner") plan.conflicts.push({ row, owner: row.label!, table: label, group, item });
    else plan.apply.push({ row, label, group, item });
  }
  return plan;
}

export function taskLabels(events: LedgerEvent[]): Map<string, TaskLabel> {
  const m = new Map<string, TaskLabel>();
  const ruled = new Map<string, TaskLabel>();
  for (const e of afterReset(events)) {
    if (e.event_type === "owner_task_label") m.set(String(e.data.task_id), e.data.label as TaskLabel);
    if (e.event_type === "rule_task_label") ruled.set(String(e.data.task_id), e.data.label as TaskLabel);
  }
  for (const [k, v] of ruled) if (!m.has(k)) m.set(k, v); // an owner answer always wins
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

/**
 * The candidate rules compared in the section 4 table: both wordings, a range of thresholds.
 * Boundary-only data says nothing about thresholds outside the boundary, nor about the other
 * wording (it was not used to choose the purchases), so with `boundary` only "necessary or
 * useful" rules with thresholds inside it are listed.
 */
export function candidateRules(dupAsk: number, boundary?: { low: number; high: number }): Rule[] {
  const out: Rule[] = [];
  if (boundary) {
    const inside = [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85].filter((x) => x >= boundary.low && x <= boundary.high);
    for (const nature_blocks of [true, false])
      for (const block of [0, ...inside])
        for (const ask of inside) if (ask > block) out.push({ wording: "necessary_or_useful", block, ask, duplicate_ask: dupAsk, nature_blocks });
    return out;
  }
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
