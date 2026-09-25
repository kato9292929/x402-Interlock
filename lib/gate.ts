import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { x402HTTPClient, x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { fromAtomic } from "./amount";
import { Ledger, type LedgerEvent } from "./ledger";
import { evaluatePolicy, loadPolicy, type Decision, type GateResult, type PaymentOption, type ReasonCode } from "./policy";
import { screen } from "./screening";
import { buyerAddress, signApproved } from "./signer";
import { createApprovalRequest, loadApprovalRequest, verifyApproval, type VerificationOutcome } from "./world";
import type { IDKitResult } from "@worldcoin/idkit-core";

const DATA = () => process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ledger = () => new Ledger();
const http = new x402HTTPClient(new x402Client());

export type Status =
  | "PAID"
  | "PAYMENT_FAILED"
  | "BLOCKED"
  | "AWAITING_HUMAN"
  | "HUMAN_REJECTED"
  | "HUMAN_EXPIRED"
  | "HUMAN_CANCELLED";

export interface GateView {
  decision_id: string;
  decision: Decision;
  reasons: ReasonCode[];
  status: Status;
  approval_url?: string;
  result?: { http_status: number; body: unknown; settlement?: unknown };
}

// --------------------------------------------------------------------------
// 402 handling
// --------------------------------------------------------------------------

/** The gate fetches the resource itself, so the requirements it evaluates are not agent-supplied. */
export async function fetchPaymentRequired(url: string): Promise<PaymentRequired> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status !== 402) throw new Error(`expected 402 from ${url}, got ${res.status}`);
  const body = await res.json().catch(() => undefined);
  return http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
}

const toOption = (r: PaymentRequirements): PaymentOption & { extra: Record<string, unknown>; maxTimeoutSeconds: number } => ({
  scheme: r.scheme,
  network: r.network,
  asset: r.asset,
  payTo: r.payTo,
  amount: r.amount,
  extra: r.extra,
  maxTimeoutSeconds: r.maxTimeoutSeconds,
});

// --------------------------------------------------------------------------
// run context from the ledger
// --------------------------------------------------------------------------

function paidEvents(all: LedgerEvent[]) {
  return all.filter((e) => e.event_type === "payment_result" && e.data.status === "PAID");
}

function runContext(all: LedgerEvent[], run_id: string, resource: string, now: Date) {
  const paid = paidEvents(all);
  const spentAtomic = paid.filter((e) => e.data.run_id === run_id).reduce((s, e) => s + BigInt(String(e.data.amount)), 0n);
  const last = paid.filter((e) => e.data.resource === resource).at(-1);
  return { spentAtomic, lastPurchaseAt: last ? new Date(last.occurred_at) : undefined, now };
}

// --------------------------------------------------------------------------
// evaluate
// --------------------------------------------------------------------------

export async function evaluate(input: { url: string; purpose: string; run_id: string; baseUrl: string }): Promise<GateView> {
  const l = ledger();
  const policy = loadPolicy();
  const decision_id = randomUUID();
  const paymentRequired = await fetchPaymentRequired(input.url);
  const options = paymentRequired.accepts.map(toOption);

  l.append(decision_id, "payment_candidate", {
    run_id: input.run_id,
    resource: input.url,
    purpose: input.purpose,
    x402Version: paymentRequired.x402Version,
    accepts: paymentRequired.accepts,
  });

  const now = new Date();
  const ctx = runContext(l.readAll(), input.run_id, input.url, now);
  const candidate = { resource: input.url, options };

  // Selection does not depend on screening (screening can only block), so find the
  // option that would be paid, screen exactly that one, then decide for real.
  const pre = evaluatePolicy(policy, candidate, { verdict: "SAFE", reasons: [] }, ctx);
  const target = (pre.selected ?? options[0]) as (typeof options)[number];
  const report = await screen(target, buyerAddress(), new URL(input.url).origin, policy.token_decimals);
  l.append(decision_id, "screening_result", {
    provider: "intercepta",
    target: { payTo: target.payTo, asset: target.asset, network: target.network, amount: target.amount },
    verdict: report.verdict,
    reasons: report.reasons,
    checks: report.checks,
  });

  const result = evaluatePolicy(policy, candidate, { verdict: report.verdict, reasons: report.reasons }, ctx);
  const selected = result.selected ? paymentRequired.accepts[options.indexOf(result.selected as (typeof options)[number])] : undefined;
  l.append(decision_id, "gate_decision", {
    decision: result.decision,
    reasons: result.reasons,
    selected: selected ?? null,
    run_spent_before: ctx.spentAtomic.toString(),
    policy,
  });
  savePending(decision_id, { paymentRequired, url: input.url, run_id: input.run_id, purpose: input.purpose, result, selected });

  if (result.decision === "BLOCK" || !selected) {
    l.append(decision_id, "payment_result", { status: "NOT_EXECUTED", run_id: input.run_id, resource: input.url, reason: "BLOCK" });
    return { decision_id, decision: result.decision, reasons: result.reasons, status: "BLOCKED" };
  }

  if (result.decision === "ASK_HUMAN") {
    const req = createApprovalRequest(decision_id, {
      payTo: selected.payTo,
      amount: selected.amount,
      amount_display: `${fromAtomic(selected.amount, policy.token_decimals)} USDC`,
      asset: selected.asset,
      network: selected.network,
      resource: input.url,
      purpose: input.purpose,
    });
    l.append(decision_id, "human_verification", {
      status: "REQUESTED",
      provider: "world_id",
      credential: "proof_of_human",
      action: req.action,
      signal: req.signal,
      environment: req.environment,
      require_user_presence: req.require_user_presence,
      rp_nonce: req.rp_context.nonce,
      expires_at: new Date(req.rp_context.expires_at * 1000).toISOString(),
    });
    return {
      decision_id,
      decision: "ASK_HUMAN",
      reasons: result.reasons,
      status: "AWAITING_HUMAN",
      approval_url: `${input.baseUrl}/approve/${decision_id}`,
    };
  }

  return execute(decision_id);
}

// --------------------------------------------------------------------------
// pending state (full PaymentRequired kept outside the ledger for signing later)
// --------------------------------------------------------------------------

interface Pending {
  paymentRequired: PaymentRequired;
  url: string;
  run_id: string;
  purpose: string;
  result: GateResult;
  selected?: PaymentRequirements;
}
const pendingFile = (id: string) => path.join(DATA(), "pending", `${id}.json`);
const resultFile = (id: string) => path.join(DATA(), "results", `${id}.json`);

function savePending(id: string, p: Pending) {
  mkdirSync(path.dirname(pendingFile(id)), { recursive: true });
  writeFileSync(pendingFile(id), JSON.stringify(p));
}
function loadPending(id: string): Pending | null {
  if (!/^[0-9a-f-]{36}$/.test(id) || !existsSync(pendingFile(id))) return null;
  return JSON.parse(readFileSync(pendingFile(id), "utf8")) as Pending;
}

// --------------------------------------------------------------------------
// execute: sign exactly the approved requirement and retry the request
// --------------------------------------------------------------------------

async function execute(decision_id: string): Promise<GateView> {
  const l = ledger();
  const p = loadPending(decision_id);
  if (!p || !p.selected) throw new Error("no pending payment");
  if (paidOrAttempted(l.byDecision(decision_id))) return view(decision_id);

  let status: Status = "PAYMENT_FAILED";
  let out: GateView["result"];
  try {
    const payload = await signApproved(p.paymentRequired, p.selected);
    const res = await fetch(p.url, { headers: http.encodePaymentSignatureHeader(payload), signal: AbortSignal.timeout(60_000) });
    const body = await res.json().catch(() => null);
    let settlement: unknown;
    try {
      settlement = http.getPaymentSettleResponse((n) => res.headers.get(n));
    } catch {
      settlement = undefined;
    }
    out = { http_status: res.status, body, settlement };
    status = res.ok ? "PAID" : "PAYMENT_FAILED";
  } catch (e) {
    out = { http_status: 0, body: { error: (e as Error).message } };
  }
  mkdirSync(path.dirname(resultFile(decision_id)), { recursive: true });
  writeFileSync(resultFile(decision_id), JSON.stringify(out));
  l.append(decision_id, "payment_result", {
    status,
    run_id: p.run_id,
    resource: p.url,
    amount: p.selected.amount,
    payTo: p.selected.payTo,
    capped: p.result.reasons.includes("PER_PAYMENT_LIMIT_CAPPED"),
    http_status: out?.http_status,
    settlement: out?.settlement ?? null,
  });
  return view(decision_id);
}

function paidOrAttempted(events: LedgerEvent[]) {
  return events.some((e) => e.event_type === "payment_result");
}

// --------------------------------------------------------------------------
// human verification paths: approve / reject / expire / cancel
// --------------------------------------------------------------------------

const TERMINAL_HUMAN = ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"];

function humanState(events: LedgerEvent[]): string | null {
  const h = events.filter((e) => e.event_type === "human_verification");
  const terminal = h.find((e) => TERMINAL_HUMAN.includes(String(e.data.status)));
  return terminal ? String(terminal.data.status) : h.length ? "REQUESTED" : null;
}

function closeHuman(decision_id: string, status: "REJECTED" | "EXPIRED" | "CANCELLED", detail: Record<string, unknown>) {
  const l = ledger();
  const p = loadPending(decision_id);
  l.append(decision_id, "human_verification", { status, ...detail });
  l.append(decision_id, "payment_result", {
    status: "NOT_EXECUTED",
    run_id: p?.run_id,
    resource: p?.url,
    reason: `HUMAN_${status}`,
  });
}

/** Lazily applies expiry: any read after expires_at closes the request as EXPIRED. */
function expireIfDue(decision_id: string, now = Date.now()) {
  const req = loadApprovalRequest(decision_id);
  if (!req) return;
  if (humanState(ledger().byDecision(decision_id)) !== "REQUESTED") return;
  if (now / 1000 > req.rp_context.expires_at) closeHuman(decision_id, "EXPIRED", { reason: "ttl_elapsed" });
}

export async function approve(decision_id: string, result: IDKitResult): Promise<{ outcome: VerificationOutcome; view: GateView }> {
  expireIfDue(decision_id);
  const req = loadApprovalRequest(decision_id);
  if (!req) throw new Error("unknown decision");
  const state = humanState(ledger().byDecision(decision_id));
  if (state !== "REQUESTED") return { outcome: { ok: false, reason: `already_${state?.toLowerCase()}` }, view: view(decision_id) };

  const outcome = await verifyApproval(req, result);
  if (!outcome.ok) {
    // A failed proof is logged but does not close the request: the owner can retry until expiry.
    ledger().append(decision_id, "human_verification", { status: "VERIFICATION_FAILED", reason: outcome.reason, world_response: outcome.world_response ?? null });
    return { outcome, view: view(decision_id) };
  }
  ledger().append(decision_id, "human_verification", {
    status: "APPROVED",
    credential: outcome.credential,
    nullifier: outcome.nullifier,
    world_response: outcome.world_response ?? null,
  });
  return { outcome, view: await execute(decision_id) };
}

export function reject(decision_id: string, reason: string): GateView {
  expireIfDue(decision_id);
  if (humanState(ledger().byDecision(decision_id)) === "REQUESTED") closeHuman(decision_id, "REJECTED", { reason });
  return view(decision_id);
}

export function cancel(decision_id: string, reason: string): GateView {
  expireIfDue(decision_id);
  if (humanState(ledger().byDecision(decision_id)) === "REQUESTED") closeHuman(decision_id, "CANCELLED", { reason });
  return view(decision_id);
}

// --------------------------------------------------------------------------
// view
// --------------------------------------------------------------------------

export function view(decision_id: string, baseUrl?: string): GateView {
  expireIfDue(decision_id);
  const events = ledger().byDecision(decision_id);
  const d = events.find((e) => e.event_type === "gate_decision");
  if (!d) throw new Error("unknown decision");
  const pr = events.find((e) => e.event_type === "payment_result");
  const h = humanState(events);
  let status: Status;
  if (pr?.data.status === "PAID") status = "PAID";
  else if (pr?.data.status === "PAYMENT_FAILED") status = "PAYMENT_FAILED";
  else if (h === "REJECTED") status = "HUMAN_REJECTED";
  else if (h === "EXPIRED") status = "HUMAN_EXPIRED";
  else if (h === "CANCELLED") status = "HUMAN_CANCELLED";
  else if (h === "REQUESTED" || h === "APPROVED") status = "AWAITING_HUMAN";
  else status = "BLOCKED";
  const res = existsSync(resultFile(decision_id)) ? JSON.parse(readFileSync(resultFile(decision_id), "utf8")) : undefined;
  return {
    decision_id,
    decision: d.data.decision as Decision,
    reasons: d.data.reasons as ReasonCode[],
    status,
    approval_url: status === "AWAITING_HUMAN" && baseUrl ? `${baseUrl}/approve/${decision_id}` : undefined,
    result: res,
  };
}
