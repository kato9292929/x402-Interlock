import { fromAtomic } from "./amount";
import { Ledger, type LedgerEvent } from "./ledger";

export interface DecisionCard {
  decision_id: string;
  started_at: string;
  resource: string;
  purpose: string;
  amount?: string;
  payTo?: string;
  decision?: string;
  reasons: string[];
  screening?: { verdict: string; reasons: string[]; checks: { check: string; verdict: string; reasons: string[]; cached?: boolean }[] };
  outcome: { label: string; cls: string };
  task_id?: string;
  action_type?: string;
  events: LedgerEvent[];
}

const usdc = (a: unknown) => (a ? `${fromAtomic(String(a), 6)} USDC` : undefined);

function actionOutcome(events: LedgerEvent[]): { label: string; cls: string } {
  const judged = events.find((e) => e.event_type === "action_judged" && e.data.phase === "judged")!;
  const human = events.filter((e) => e.event_type === "action_judged" && e.data.phase === "human").at(-1);
  const decision = String(judged.data.decision);
  if (judged.data.kind === "send") {
    const sent = events.find((e) => e.event_type === "action_sent");
    if (sent?.data.status === "SENT") return { label: "Sent by the gate", cls: "PAID" };
    if (sent) {
      const r = String(sent.data.reason);
      if (r === "DENY") return { label: "Not sent: denied by policy (no approval can override)", cls: "BLOCKED" };
      return { label: `Not sent: ${r.startsWith("HUMAN_") ? r.replace("HUMAN_", "owner ").toLowerCase() : r}`, cls: "BLOCKED" };
    }
    if (decision === "BLOCK") return { label: `Not sent: ${(judged.data.reasons as string[]).join(", ")}`, cls: "BLOCKED" };
    return { label: "Held: waiting for the owner's World ID approval", cls: "AWAITING_HUMAN" };
  }
  if (decision === "DENY") return { label: "Stopped: denied by policy (no approval can override)", cls: "BLOCKED" };
  if (decision === "BLOCK") return { label: `Stopped: ${(judged.data.reasons as string[]).join(", ")}`, cls: "BLOCKED" };
  if (decision === "ALLOW") return judged.data.notify ? { label: "Allowed (owner notified)", cls: "PAID" } : { label: "Allowed", cls: "PAID" };
  if (human?.data.outcome === "APPROVED") return { label: "Approved by the owner (the agent performs it)", cls: "PAID" };
  if (human) return { label: `Stopped: ${String(human.data.outcome).replace("HUMAN_", "owner ").toLowerCase()}`, cls: "BLOCKED" };
  return { label: "Waiting for the owner's World ID approval", cls: "AWAITING_HUMAN" };
}

function outcome(events: LedgerEvent[]): { label: string; cls: string } {
  const pr = events.find((e) => e.event_type === "payment_result");
  const h = events.filter((e) => e.event_type === "human_verification").at(-1);
  if (pr?.data.status === "PAID") {
    return pr.data.capped ? { label: "Paid (capped to a cheaper option)", cls: "CAP" } : { label: "Paid", cls: "PAID" };
  }
  if (pr?.data.status === "PAYMENT_FAILED") return { label: "Signed, but the seller did not settle", cls: "PAYMENT_FAILED" };
  if (pr?.data.status === "NOT_EXECUTED") {
    const r = String(pr.data.reason);
    if (pr.data.phase === "signing") return { label: `Stopped at signing: ${r}`, cls: "BLOCKED" };
    return { label: r === "BLOCK" ? "Stopped: blocked" : `Stopped: ${r.replace("HUMAN_", "owner ").toLowerCase()}`, cls: "BLOCKED" };
  }
  if (h) return { label: "Waiting for the owner's World ID approval", cls: "AWAITING_HUMAN" };
  return { label: "Evaluating", cls: "" };
}

export function decisionCards(ledger = new Ledger()): { cards: DecisionCard[]; chainBrokenAt: number } {
  const byId = new Map<string, LedgerEvent[]>();
  for (const e of ledger.readAll()) byId.set(e.decision_id, [...(byId.get(e.decision_id) ?? []), e]);
  // Task open/close events share the task id as decision id; they are shown on /tasks instead.
  const entries = [...byId.entries()].filter(([, ev]) =>
    ev.some((e) => e.event_type === "payment_candidate" || (e.event_type === "action_judged" && e.data.phase === "judged")),
  );
  const cards = entries.map(([decision_id, events]): DecisionCard => {
    const judged = events.find((e) => e.event_type === "action_judged" && e.data.phase === "judged");
    if (judged?.data.kind === "send") {
      const found = ((judged.data.detected as { field: string; parts: string[] }[]) ?? []).map((d) => `${d.field} (${d.parts.join(", ")})`);
      return {
        decision_id,
        started_at: events[0].occurred_at,
        resource: `send via ${judged.data.channel}: ${judged.data.action_type ?? "nothing sensitive found"} (policy ${judged.data.action_policy})`,
        purpose: found.length ? `found: ${found.join("; ")}` : `${judged.data.body_length} characters, nothing found`,
        amount: "none (no money moves)",
        decision: String(judged.data.decision),
        reasons: (judged.data.reasons as string[]) ?? [],
        outcome: actionOutcome(events),
        task_id: (judged.data.task_id as string) ?? undefined,
        action_type: String(judged.data.action_type ?? "send"),
        events,
      };
    }
    if (judged) {
      const summary = judged.data.payload_summary as { description?: string; fields?: string[] };
      return {
        decision_id,
        started_at: events[0].occurred_at,
        resource: `action: ${judged.data.action_type} (policy ${judged.data.action_policy})`,
        purpose: summary.description || `fields: ${(summary.fields ?? []).join(", ")}`,
        amount: "none (no money moves)",
        decision: String(judged.data.decision),
        reasons: (judged.data.reasons as string[]) ?? [],
        outcome: actionOutcome(events),
        task_id: (judged.data.task_id as string) ?? undefined,
        action_type: String(judged.data.action_type),
        events,
      };
    }
    const c = events.find((e) => e.event_type === "payment_candidate");
    const s = events.find((e) => e.event_type === "screening_result");
    const d = events.find((e) => e.event_type === "gate_decision");
    const sel = (d?.data.selected ?? (c?.data.accepts as Record<string, unknown>[] | undefined)?.[0]) as Record<string, unknown> | undefined;
    return {
      decision_id,
      started_at: events[0].occurred_at,
      resource: String(c?.data.resource ?? ""),
      purpose: String(c?.data.purpose ?? ""),
      amount: usdc(sel?.amount),
      payTo: sel?.payTo as string | undefined,
      decision: d?.data.decision as string | undefined,
      reasons: (d?.data.reasons as string[]) ?? [],
      screening: s
        ? {
            verdict: String(s.data.verdict),
            reasons: s.data.reasons as string[],
            checks: ((s.data.checks as { check: string; verdict: string; reasons: string[]; cache?: unknown }[]) ?? []).map((k) => ({
              check: k.check,
              verdict: k.verdict,
              reasons: k.reasons,
              cached: !!k.cache,
            })).concat(
              // Checks that do not apply (Scan Message on Solana) are shown, not silently absent.
              ((s.data.skipped as { check: string; code: string }[]) ?? []).map((k) => ({ check: k.check, verdict: "SKIPPED", reasons: [k.code], cached: false })),
            ),
          }
        : undefined,
      outcome: outcome(events),
      task_id: (c?.data.task_id as string) ?? undefined,
      action_type: "pay",
      events,
    };
  });
  return { cards: cards.reverse(), chainBrokenAt: ledger.verify() };
}
