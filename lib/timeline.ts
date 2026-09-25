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
  screening?: { verdict: string; reasons: string[]; checks: { check: string; verdict: string; reasons: string[] }[] };
  outcome: { label: string; cls: string };
  events: LedgerEvent[];
}

const usdc = (a: unknown) => (a ? `${fromAtomic(String(a), 6)} USDC` : undefined);

function outcome(events: LedgerEvent[]): { label: string; cls: string } {
  const pr = events.find((e) => e.event_type === "payment_result");
  const h = events.filter((e) => e.event_type === "human_verification").at(-1);
  if (pr?.data.status === "PAID") {
    return pr.data.capped ? { label: "Paid (capped to a cheaper option)", cls: "CAP" } : { label: "Paid", cls: "PAID" };
  }
  if (pr?.data.status === "PAYMENT_FAILED") return { label: "Signed, but the seller did not settle", cls: "PAYMENT_FAILED" };
  if (pr?.data.status === "NOT_EXECUTED") {
    const r = String(pr.data.reason);
    return { label: r === "BLOCK" ? "Stopped: blocked" : `Stopped: ${r.replace("HUMAN_", "owner ").toLowerCase()}`, cls: "BLOCKED" };
  }
  if (h) return { label: "Waiting for the owner's World ID approval", cls: "AWAITING_HUMAN" };
  return { label: "Evaluating", cls: "" };
}

export function decisionCards(ledger = new Ledger()): { cards: DecisionCard[]; chainBrokenAt: number } {
  const byId = new Map<string, LedgerEvent[]>();
  for (const e of ledger.readAll()) byId.set(e.decision_id, [...(byId.get(e.decision_id) ?? []), e]);
  const cards = [...byId.entries()].map(([decision_id, events]) => {
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
            checks: ((s.data.checks as { check: string; verdict: string; reasons: string[] }[]) ?? []).map((k) => ({
              check: k.check,
              verdict: k.verdict,
              reasons: k.reasons,
            })),
          }
        : undefined,
      outcome: outcome(events),
      events,
    };
  });
  return { cards: cards.reverse(), chainBrokenAt: ledger.verify() };
}
