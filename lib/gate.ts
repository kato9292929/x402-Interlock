import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { x402HTTPClient, x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { fromAtomic, toAtomic } from "./amount";
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
import { isActionType, loadActionPolicies, type ActionPolicy, type ActionType } from "./actions";
import { deliver, isChannel, type Channel } from "./inbox";
import { detectDisclosure, type Detection } from "./protect";
import { loadThresholds, spendGuardShadow, type SpendGuardReview } from "./appe";
import { screen, type ScreeningReport } from "./screening";
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
  | "HUMAN_CANCELLED"
  | "SENT";

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
  /** Spend Guard in shadow mode: what it would have done. It did not change this decision. */
  spend_guard?: Pick<SpendGuardReview, "mode" | "would_have" | "would_have_reasons" | "necessity_prob" | "duplicate_prob" | "nature" | "jev_model" | "jev_status" | "jev_reason">;
  /** For a message sent through the gate: what the gate found in it (no matched values). */
  detected?: Detection[];
  message_id?: string;
  /** One line per screening check, so a BLOCK says which check failed and how (no secrets in it). */
  screening?: ScreeningSummary[];
}

export interface ScreeningSummary {
  check: string;
  verdict: string;
  http_status?: number;
  reasons: string[];
  error?: string;
}

function summarizeScreening(report: ScreeningReport): ScreeningSummary[] {
  const out: ScreeningSummary[] = report.checks.map((c) => ({
    check: c.check,
    verdict: c.verdict,
    ...(c.http_status !== undefined ? { http_status: c.http_status } : {}),
    reasons: c.reasons,
    ...(c.error ? { error: c.error } : {}),
  }));
  for (const s of report.skipped ?? []) out.push({ check: s.check, verdict: "SKIPPED", reasons: [s.code, s.detail] });
  // No check ran at all (e.g. no mainnet stand-in configured): the report's own reasons say why.
  if (!report.checks.length && report.verdict !== "SAFE") out.unshift({ check: "screening", verdict: report.verdict, reasons: report.reasons });
  return out;
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
  let task: ReturnType<typeof checkTask>["task"];
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
    task = t.task;
  }

  // Spend Guard (spec/07), shadow mode: asked in parallel with screening, recorded next to the
  // decision, never applied. Skipped when the fixed rules already block (principle 7).
  const spendGuard = task && pre.decision !== "BLOCK" ? startSpendGuard(task, input.url, paymentRequired, BigInt(target.amount), policy.token_decimals, l.readAll()) : undefined;

  const payToMainnet = mainnetScreeningAddress(policy, target.payTo as TestnetAddress);
  // Scan Message needs an EVM `from`; it does not apply on Solana (lib/screening.ts).
  const buyer = onSolana ? undefined : screeningFromAddressOrUndefined();
  const report = await screen(target, payToMainnet, buyer, new URL(input.url).origin, policy.token_decimals);
  const screening = summarizeScreening(report);
  // The server log says which check failed and how, not only the reason code.
  for (const c of screening) {
    console.log(`[screening] ${decision_id} ${c.check} ${c.verdict}${c.http_status !== undefined ? ` HTTP ${c.http_status}` : ""} ${c.reasons.join("; ")}${c.error ? ` (error: ${c.error})` : ""}`);
  }
  l.append(decision_id, "screening_result", {
    task_id: task_id ?? null,
    provider: "intercepta",
    target: { payTo: target.payTo, asset: target.asset, network: target.network, amount: target.amount },
    screened_as: report.screened_as ?? null,
    verdict: report.verdict,
    reasons: report.reasons,
    checks: report.checks,
    skipped: report.skipped ?? [],
  });

  const result = evaluatePolicy(policy, candidate, { verdict: report.verdict, reasons: report.reasons }, ctx);
  // Action policy for "pay" sits on top of the money rules; it can only make them stricter.
  if (task_id !== undefined && actionPolicy === "ask_human" && (result.decision === "PAY" || result.decision === "CAP")) {
    result.decision = "ASK_HUMAN";
    result.reasons.push("ACTION_ASK_HUMAN");
  }
  for (const s of report.skipped ?? []) result.reasons.push(s.code);
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
  const sg = spendGuard ? await recordSpendGuard(decision_id, task!.task_id, input.url, target.amount, result.decision, spendGuard) : undefined;

  if (result.decision === "BLOCK" || !selected) {
    l.append(decision_id, "payment_result", { task_id: task_id ?? null, status: "NOT_EXECUTED", run_id, resource: input.url, reason: "BLOCK" });
    return { decision_id, decision: result.decision, reasons: result.reasons, status: "BLOCKED", task_id, screening, spend_guard: sg };
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
      screening,
      spend_guard: sg,
    };
  }

  return { ...(await execute(decision_id)), screening, spend_guard: sg };
}

function startSpendGuard(
  task: NonNullable<ReturnType<typeof checkTask>["task"]>,
  url: string,
  paymentRequired: PaymentRequired,
  amount: bigint,
  decimals: number,
  all: LedgerEvent[],
): Promise<SpendGuardReview> | undefined {
  let t;
  try {
    t = loadThresholds();
  } catch (e) {
    console.log(`[spend-guard] thresholds not loaded: ${(e as Error).message}`);
    return undefined;
  }
  if (t.spend_guard.mode === "off") return undefined;
  const description = (paymentRequired.resource as { description?: unknown } | undefined)?.description;
  return spendGuardShadow(
    {
      task: { task_id: task.task_id, purpose: task.purpose, budget_atomic: toAtomic(task.budget.amount, decimals) },
      candidate: { url, description: typeof description === "string" ? description : null, amount_atomic: amount },
      ledger: all,
      decimals,
    },
    t,
  );
}

async function recordSpendGuard(decision_id: string, task_id: string, url: string, amount: string, actual: Decision, p: Promise<SpendGuardReview>) {
  const r = await p;
  ledger().append(decision_id, "spend_guard_review", { task_id, url, amount, actual_decision: actual, ...r });
  console.log(
    `[spend-guard] ${decision_id} shadow would_have=${r.would_have}${r.would_have_reasons.length ? ` (${r.would_have_reasons.join(", ")})` : ""} ` +
      (r.jev_status === "OK" ? `necessity=${r.necessity_prob} duplicate=${r.duplicate_prob} nature=${r.nature} model=${r.jev_model}` : `UNAVAILABLE: ${r.jev_reason}`),
  );
  const { mode, would_have, would_have_reasons, necessity_prob, duplicate_prob, nature, jev_model, jev_status, jev_reason } = r;
  return { mode, would_have, would_have_reasons, necessity_prob, duplicate_prob, nature, jev_model, jev_status, jev_reason };
}

function screeningFromAddressOrUndefined(): string | undefined {
  try {
    return screeningFromAddress();
  } catch {
    return undefined; // screen() reports it as UNAVAILABLE with the reason
  }
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
  | { kind: "action"; task_id?: string; action_type: ActionType; payload_sha256: string; run_id?: undefined; url?: undefined }
  | {
      kind: "send";
      task_id?: string;
      action_type: ActionType | null;
      channel: Channel;
      to: string;
      body: string;
      message_sha256: string;
      detected: Detection[];
      run_id?: undefined;
      url?: undefined;
    };
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
  if (!p || p.kind === "action" || p.kind === "send" || !p.selected) throw new Error("no pending payment");
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
    // An identifier for the data obtained (Spend Guard history), never the data itself.
    body_sha256: status === "PAID" && out?.body != null ? createHash("sha256").update(JSON.stringify(out.body)).digest("hex") : null,
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
  if (p?.kind === "action" || p?.kind === "send") {
    l.append(decision_id, "action_judged", { task_id: p.task_id ?? null, phase: "human", action_type: p.action_type, outcome: `HUMAN_${status}` });
    if (p.kind === "send") l.append(decision_id, "action_sent", { task_id: p.task_id ?? null, status: "NOT_SENT", reason: `HUMAN_${status}`, channel: p.channel });
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
  // A message the gate holds: send exactly the bytes the owner approved.
  if (p?.kind === "send") {
    ledger().append(decision_id, "action_judged", { task_id: p.task_id ?? null, phase: "human", action_type: p.action_type, outcome: "APPROVED" });
    sendHeld(decision_id, p, req.summary.asset);
    return { outcome, view: view(decision_id) };
  }
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
  const sent = events.find((e) => e.event_type === "action_sent" && e.data.status === "SENT");
  if (sent) status = "SENT";
  else if (action) {
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
    detected: (action?.data.detected as Detection[] | undefined) ?? undefined,
    message_id: (sent?.data.message_id as string | undefined) ?? undefined,
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

// --------------------------------------------------------------------------
// messages sent through the gate (phase 1 of docs/PROPOSAL-action-executor.md)
// --------------------------------------------------------------------------

const STRICTNESS: ActionPolicy[] = ["allow", "notify", "ask_human", "deny"];

/** The message as bound to an approval: channel, recipient and body, exactly. */
export function messageSha256(channel: string, to: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([channel, to, body])).digest("hex");
}

/**
 * The agent asks the gate to send a message; it holds no credential for the channel itself.
 * The gate reads the text (the owner's registered data, then patterns for personal data),
 * takes the strictest policy of every type it found plus the type the agent declared, and
 * sends only when that policy allows it or the owner approves this exact message.
 */
export async function sendMessage(input: {
  task_id?: string;
  channel: string;
  to: string;
  body: string;
  declared_type?: string;
  baseUrl: string;
}): Promise<GateView> {
  if (!isChannel(input.channel)) throw new Error(`unknown channel ${input.channel}`);
  if (typeof input.to !== "string" || !input.to.trim()) throw new Error("to is required");
  if (typeof input.body !== "string" || !input.body.trim()) throw new Error("body is required");
  if (input.body.length > 4000) throw new Error("body is longer than 4000 characters");
  if (input.declared_type !== undefined && (!isActionType(input.declared_type) || input.declared_type === "pay")) {
    throw new Error("declared_type must be commit, disclose or impersonate");
  }
  const channel = input.channel;
  const { to, body, task_id } = input;
  const decision_id = randomUUID();
  const message_sha256 = messageSha256(channel, to, body);
  const policies = loadActionPolicies();

  const detected = detectDisclosure(body);
  const types = new Set<ActionType>(detected.map((d) => d.type));
  if (input.declared_type) types.add(input.declared_type as ActionType);
  // Strictest policy wins; the agent's declaration can only add to what the gate found.
  const ordered = [...types].sort((a, b) => STRICTNESS.indexOf(policies[b]) - STRICTNESS.indexOf(policies[a]));
  const action_type = ordered[0] ?? null;
  const policy: ActionPolicy = action_type ? policies[action_type] : "allow";

  const contentReasons: ReasonCode[] = [];
  if (detected.some((d) => d.source === "protected")) contentReasons.push("CONTENT_PROTECTED_MATCH");
  if (detected.some((d) => d.source === "pattern")) contentReasons.push("CONTENT_PATTERN_MATCH");
  if (input.declared_type) contentReasons.push("DECLARED_TYPE");
  if (!detected.length) contentReasons.push("CONTENT_NONE_DETECTED");

  let decision: Decision;
  let reasons: ReasonCode[];
  const t = checkTask(task_id);
  if (t.reason) {
    decision = "BLOCK";
    reasons = [t.reason];
  } else if (policy === "deny") {
    decision = "DENY";
    reasons = ["ACTION_DENIED", ...contentReasons];
  } else if (policy === "ask_human") {
    decision = "ASK_HUMAN";
    reasons = ["ACTION_ASK_HUMAN", ...contentReasons];
  } else {
    decision = "ALLOW";
    reasons = [policy === "notify" ? "ACTION_NOTIFY" : "ACTION_ALLOW", ...contentReasons];
  }
  const held = { kind: "send" as const, task_id, action_type, channel, to, body, message_sha256, detected };
  // Prepare the approval before recording the decision, so a World ID setup error fails the
  // request instead of leaving a held message that can never be approved.
  // The World ID signal binds the proof to this exact channel, recipient and body.
  const req =
    decision === "ASK_HUMAN"
      ? createApprovalRequest(decision_id, {
          payTo: `send:${channel}`,
          amount: "0",
          amount_display: "no payment",
          asset: message_sha256,
          network: "interlock:action",
          resource: ordered.join(", ") || "send",
          purpose: `send a message to ${to}`,
        })
      : undefined;
  const notify = decision === "ALLOW" && policy === "notify";
  // The ledger gets hashes and what was found, never the body, the recipient or a matched value.
  ledger().append(decision_id, "action_judged", {
    phase: "judged",
    kind: "send",
    task_id: task_id ?? null,
    channel,
    to_sha256: createHash("sha256").update(to).digest("hex"),
    message_sha256,
    body_length: body.length,
    declared_type: input.declared_type ?? null,
    types: ordered,
    action_type,
    action_policy: policy,
    decision,
    reasons,
    notify,
    detected,
  });

  if (decision === "ALLOW") {
    sendHeld(decision_id, held, message_sha256);
  } else if (req) {
    savePending(decision_id, held);
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
  } else {
    ledger().append(decision_id, "action_sent", { task_id: task_id ?? null, status: "NOT_SENT", reason: decision, channel });
  }
  return view(decision_id, input.baseUrl);
}

/**
 * Deliver a held message, but only if it is still the message that was judged (and approved):
 * the hash bound to the decision must match what is about to go out. Sent at most once.
 */
function sendHeld(decision_id: string, p: Extract<Pending, { kind: "send" }>, boundSha256: string) {
  const l = ledger();
  if (l.byDecision(decision_id).some((e) => e.event_type === "action_sent")) return;
  const now = messageSha256(p.channel, p.to, p.body);
  if (now !== boundSha256 || now !== p.message_sha256) {
    l.append(decision_id, "action_sent", { task_id: p.task_id ?? null, status: "NOT_SENT", reason: "MESSAGE_CHANGED", channel: p.channel });
    return;
  }
  // The task may have been closed while the owner was deciding.
  const t = checkTask(p.task_id);
  if (t.reason) {
    l.append(decision_id, "action_sent", { task_id: p.task_id ?? null, status: "NOT_SENT", reason: t.reason, channel: p.channel });
    return;
  }
  const msg = deliver(decision_id, p.channel, p.to, p.body);
  l.append(decision_id, "action_sent", { task_id: p.task_id ?? null, status: "SENT", channel: p.channel, message_id: msg.message_id, message_sha256: now });
}

/** For the approval page only: the held message, so the owner sees exactly what would be sent. */
export function heldMessage(decision_id: string): { channel: string; to: string; body: string; detected: Detection[] } | null {
  const p = loadPending(decision_id);
  return p?.kind === "send" ? { channel: p.channel, to: p.to, body: p.body, detected: p.detected } : null;
}
