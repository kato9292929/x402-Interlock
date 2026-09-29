import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { x402HTTPClient, x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { fromAtomic } from "./amount";
import { Ledger, type LedgerEvent } from "./ledger";
import {
  evaluatePolicy,
  loadPolicy,
  mainnetScreeningAddress,
  type Decision,
  type GateResult,
  type PaymentOption,
  type ReasonCode,
  type TestnetAddress,
} from "./policy";
import { createHash } from "node:crypto";
import { isActionType, loadActionPolicies, type ActionType } from "./actions";
import { screen } from "./screening";
import { screeningFromAddress, signApproved } from "./signer";
import { isSolanaNetwork } from "./solana/config";
import { allowanceChain } from "./solana/allowance";
import { checkAllowance, checkTask } from "./tasks";
import { createApprovalRequest, loadApprovalRequest, verifyApproval, type VerificationOutcome } from "./world";
import type { IDKitResult } from "@worldcoin/idkit-core";

const DATA = () => process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ledger = () => new Ledger();
const http = new x402HTTPClient(new x402Client());

export type Status =
  | "ALLOWED"
  | "DENIED"
  | "APPROVED"
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
  task_id?: string;
  action_type?: ActionType;
  notify?: boolean;
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

export async function evaluate(input: {
  url: string;
  purpose: string;
  run_id?: string;
  task_id?: string;
  baseUrl: string;
}): Promise<GateView> {
  const l = ledger();
  const policy = loadPolicy();
  const actionPolicy = loadActionPolicies().pay;
  const decision_id = randomUUID();
  const task_id = input.task_id;
  // A task is the budget unit: its id doubles as the run id for the run-level rules.
  const run_id = task_id ?? input.run_id ?? "default";
  const paymentRequired = await fetchPaymentRequired(input.url);
  const options = paymentRequired.accepts.map(toOption);

  l.append(decision_id, "payment_candidate", {
    task_id: task_id ?? null,
    run_id,
    resource: input.url,
    purpose: input.purpose,
    x402Version: paymentRequired.x402Version,
    accepts: paymentRequired.accepts,
  });

  const now = new Date();
  const ctx = runContext(l.readAll(), run_id, input.url, now);
  const candidate = { resource: input.url, options };

  // Selection does not depend on screening (screening can only block), so find the
  // option that would be paid, screen exactly that one, then decide for real.
  const pre = evaluatePolicy(policy, candidate, { verdict: "SAFE", reasons: [] }, ctx);
  const target = (pre.selected ?? options[0]) as (typeof options)[number];

  // Task checks come first. They apply to every Solana payment (the budget lives in a Solana
  // Allowance) and to any payment that names a task. The legacy Base path without a task is
  // unchanged. Steps 1-3 need no network; 4-5 read the Allowance from chain right now.
  const onSolana = !!target && isSolanaNetwork(target.network);
  if (onSolana || task_id !== undefined) {
    const blockEarly = (reason: ReasonCode, extra: Record<string, unknown> = {}): GateView => {
      l.append(decision_id, "gate_decision", { task_id: task_id ?? null, decision: "BLOCK", reasons: [reason], selected: null, ...extra });
      l.append(decision_id, "payment_result", { task_id: task_id ?? null, status: "NOT_EXECUTED", run_id, resource: input.url, reason: "BLOCK" });
      return { decision_id, decision: "BLOCK", reasons: [reason], status: "BLOCKED", task_id };
    };
    const t = checkTask(task_id, now);
    if (t.reason) return blockEarly(t.reason);
    if (!onSolana) return blockEarly("TASK_REQUIRES_SOLANA");
    if (actionPolicy === "deny") return blockEarly("ACTION_DENIED", { action_type: "pay", action_policy: actionPolicy });
    const a = await checkAllowance(t.task!, BigInt(target.amount), { decision_id, phase: "evaluate" }, now);
    if (!a.ok) return blockEarly(a.reason);
  }

  const payToMainnet = mainnetScreeningAddress(policy, target.payTo as TestnetAddress);
  const report = await screen(target, payToMainnet, screeningFromAddress(), new URL(input.url).origin, policy.token_decimals);
  l.append(decision_id, "screening_result", {
    task_id: task_id ?? null,
    provider: "intercepta",
    target: { payTo: target.payTo, asset: target.asset, network: target.network, amount: target.amount },
    screened_as: report.screened_as ?? null,
    verdict: report.verdict,
    reasons: report.reasons,
    checks: report.checks,
  });

  const result = evaluatePolicy(policy, candidate, { verdict: report.verdict, reasons: report.reasons }, ctx);
  // Action policy for "pay" sits on top of the money rules; it can only make them stricter.
  if (task_id !== undefined && actionPolicy === "ask_human" && (result.decision === "PAY" || result.decision === "CAP")) {
    result.decision = "ASK_HUMAN";
    result.reasons.push("ACTION_ASK_HUMAN");
  }
  const notify = task_id !== undefined && actionPolicy === "notify" && result.decision !== "BLOCK";
  if (notify) result.reasons.push("ACTION_NOTIFY");
  const selected = result.selected ? paymentRequired.accepts[options.indexOf(result.selected as (typeof options)[number])] : undefined;
  l.append(decision_id, "gate_decision", {
    task_id: task_id ?? null,
    decision: result.decision,
    reasons: result.reasons,
    selected: selected ?? null,
    run_spent_before: ctx.spentAtomic.toString(),
    action_type: "pay",
    action_policy: actionPolicy,
    notify,
    policy,
  });
  savePending(decision_id, { kind: "pay", task_id, paymentRequired, url: input.url, run_id, purpose: input.purpose, result, selected });

  if (result.decision === "BLOCK" || !selected) {
    l.append(decision_id, "payment_result", { task_id: task_id ?? null, status: "NOT_EXECUTED", run_id, resource: input.url, reason: "BLOCK" });
    return { decision_id, decision: result.decision, reasons: result.reasons, status: "BLOCKED", task_id };
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
      task_id: task_id ?? null,
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
      task_id,
    };
  }

  return execute(decision_id);
}

// --------------------------------------------------------------------------
// pending state (full PaymentRequired kept outside the ledger for signing later)
// --------------------------------------------------------------------------

type Pending =
  | {
      kind?: "pay";
      task_id?: string;
      paymentRequired: PaymentRequired;
      url: string;
      run_id: string;
      purpose: string;
      result: GateResult;
      selected?: PaymentRequirements;
    }
  | { kind: "action"; task_id?: string; action_type: ActionType; payload_sha256: string; run_id?: undefined; url?: undefined };
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
  if (!p || p.kind === "action" || !p.selected) throw new Error("no pending payment");
  if (paidOrAttempted(l.byDecision(decision_id))) return view(decision_id);
  const task_id = p.task_id ?? null;

  // Re-check the task and read the Allowance again immediately before signing. Nothing from
  // evaluate() is reused: an owner may have closed the task, or other payments may have used
  // the budget, while this one waited for approval.
  let pull_tx: string | undefined;
  if (isSolanaNetwork(p.selected.network)) {
    const notExecuted = (reason: string) => {
      l.append(decision_id, "payment_result", { task_id, status: "NOT_EXECUTED", run_id: p.run_id, resource: p.url, reason, phase: "signing" });
      return view(decision_id);
    };
    const t = checkTask(p.task_id);
    if (t.reason) return notExecuted(t.reason);
    const amount = BigInt(p.selected.amount);
    const a = await checkAllowance(t.task!, amount, { decision_id, phase: "signing" });
    if (!a.ok) return notExecuted(a.reason);
    try {
      // Pull exactly this payment's amount under the Allowance into the gate's account,
      // then pay from there with a standard x402 Solana payment.
      pull_tx = (await allowanceChain().pull(t.task!.allowance.pubkey, amount)).signature;
    } catch (e) {
      l.append(decision_id, "payment_result", { task_id, status: "PAYMENT_FAILED", run_id: p.run_id, resource: p.url, reason: "ALLOWANCE_PULL_FAILED", error: (e as Error).message });
      return view(decision_id);
    }
  }

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
    task_id,
    status,
    run_id: p.run_id,
    resource: p.url,
    pull_tx: pull_tx ?? null,
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
  l.append(decision_id, "human_verification", { task_id: p?.task_id ?? null, status, ...detail });
  if (p?.kind === "action") {
    l.append(decision_id, "action_judged", { task_id: p.task_id ?? null, phase: "human", action_type: p.action_type, outcome: `HUMAN_${status}` });
  } else {
    l.append(decision_id, "payment_result", {
      task_id: p?.task_id ?? null,
      status: "NOT_EXECUTED",
      run_id: p?.run_id,
      resource: p?.url,
      reason: `HUMAN_${status}`,
    });
  }
}

/** Lazily applies expiry: any read after expires_at closes the request as EXPIRED. */
function expireIfDue(decision_id: string, now = Date.now()) {
  const req = loadApprovalRequest(decision_id);
  if (!req) return;
  if (humanState(ledger().byDecision(decision_id)) !== "REQUESTED") return;
  if (now / 1000 > req.rp_context.expires_at) closeHuman(decision_id, "EXPIRED", { reason: "ttl_elapsed" });
}

/** Close every open request whose TTL has passed (used by the timeline). */
export function expireAllDue() {
  const open = new Set(
    ledger()
      .readAll()
      .filter((e) => e.event_type === "human_verification" && e.data.status === "REQUESTED")
      .map((e) => e.decision_id),
  );
  for (const id of open) expireIfDue(id);
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
  const p = loadPending(decision_id);
  ledger().append(decision_id, "human_verification", {
    task_id: p?.task_id ?? null,
    status: "APPROVED",
    credential: outcome.credential,
    nullifier: outcome.nullifier,
    world_response: outcome.world_response ?? null,
  });
  // A non-payment action is only judged here; the agent carries it out itself.
  if (p?.kind === "action") {
    ledger().append(decision_id, "action_judged", { task_id: p.task_id ?? null, phase: "human", action_type: p.action_type, outcome: "APPROVED" });
    return { outcome, view: view(decision_id) };
  }
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
  const action = events.find((e) => e.event_type === "action_judged" && e.data.phase === "judged");
  const d = events.find((e) => e.event_type === "gate_decision") ?? action;
  if (!d) throw new Error("unknown decision");
  const decision = d.data.decision as Decision;
  const pr = events.find((e) => e.event_type === "payment_result");
  const h = humanState(events);
  const humanStatus: Record<string, Status> = { REJECTED: "HUMAN_REJECTED", EXPIRED: "HUMAN_EXPIRED", CANCELLED: "HUMAN_CANCELLED" };
  const reasons = [...(d.data.reasons as ReasonCode[])];
  let status: Status;
  if (action) {
    if (decision === "ALLOW") status = "ALLOWED";
    else if (decision === "DENY") status = "DENIED";
    else if (decision === "BLOCK") status = "BLOCKED";
    else if (h === "APPROVED") status = "APPROVED";
    else status = humanStatus[h ?? ""] ?? "AWAITING_HUMAN";
  } else if (pr?.data.status === "PAID") status = "PAID";
  else if (pr?.data.status === "PAYMENT_FAILED") status = "PAYMENT_FAILED";
  else if (pr?.data.status === "NOT_EXECUTED") {
    const r = String(pr.data.reason);
    status = humanStatus[r.replace(/^HUMAN_/, "")] ?? "BLOCKED";
    // Stopped at the signing-time re-check: show why.
    if (pr.data.phase === "signing" && !reasons.includes(r as ReasonCode)) reasons.push(r as ReasonCode);
  } else if (h === "REQUESTED" || h === "APPROVED") status = "AWAITING_HUMAN";
  else status = "BLOCKED";
  const res = existsSync(resultFile(decision_id)) ? JSON.parse(readFileSync(resultFile(decision_id), "utf8")) : undefined;
  return {
    decision_id,
    decision,
    reasons,
    status,
    approval_url: status === "AWAITING_HUMAN" && baseUrl ? `${baseUrl}/approve/${decision_id}` : undefined,
    task_id: (d.data.task_id as string | null) ?? undefined,
    action_type: (d.data.action_type as ActionType | undefined) ?? undefined,
    notify: d.data.notify === true || undefined,
    result: res,
  };
}

// --------------------------------------------------------------------------
// non-payment actions: commit / disclose / impersonate
// --------------------------------------------------------------------------

/**
 * Judge an action that moves no money. The gate decides and records; it never performs the
 * action. The payload itself is not stored (it may hold an address or a phone number): only
 * its SHA-256, its field names, and the agent's one-line description.
 */
export async function evaluateAction(input: {
  task_id?: string;
  action_type: string;
  payload: unknown;
  baseUrl: string;
}): Promise<GateView> {
  if (!isActionType(input.action_type) || input.action_type === "pay") throw new Error("action_type must be commit, disclose or impersonate");
  const action_type = input.action_type;
  const policy = loadActionPolicies()[action_type];
  const decision_id = randomUUID();
  const task_id = input.task_id;
  const payloadJson = JSON.stringify(input.payload ?? null);
  const payload_sha256 = createHash("sha256").update(payloadJson).digest("hex");
  const obj = input.payload && typeof input.payload === "object" ? (input.payload as Record<string, unknown>) : {};
  const description = typeof obj.description === "string" ? obj.description.slice(0, 200) : "";
  const payload_summary = { sha256: payload_sha256, fields: Object.keys(obj).sort(), description };

  let decision: Decision;
  let reasons: ReasonCode[];
  const t = checkTask(task_id);
  if (t.reason) {
    decision = "BLOCK";
    reasons = [t.reason];
  } else if (policy === "deny") {
    decision = "DENY";
    reasons = ["ACTION_DENIED"];
  } else if (policy === "ask_human") {
    decision = "ASK_HUMAN";
    reasons = ["ACTION_ASK_HUMAN"];
  } else {
    decision = "ALLOW";
    reasons = [policy === "notify" ? "ACTION_NOTIFY" : "ACTION_ALLOW"];
  }
  const notify = decision === "ALLOW" && policy === "notify";
  ledger().append(decision_id, "action_judged", {
    phase: "judged",
    task_id: task_id ?? null,
    action_type,
    action_policy: policy,
    decision,
    reasons,
    notify,
    payload_summary,
  });

  if (decision === "ASK_HUMAN") {
    savePending(decision_id, { kind: "action", task_id, action_type, payload_sha256 });
    // The World ID signal binds the proof to this action type and this exact payload.
    const req = createApprovalRequest(decision_id, {
      payTo: `action:${action_type}`,
      amount: "0",
      amount_display: "no payment",
      asset: payload_sha256,
      network: "interlock:action",
      resource: action_type,
      purpose: description || `${action_type} (${payload_summary.fields.join(", ") || "no fields"})`,
    });
    ledger().append(decision_id, "human_verification", {
      task_id: task_id ?? null,
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
  }
  return view(decision_id, input.baseUrl);
}
