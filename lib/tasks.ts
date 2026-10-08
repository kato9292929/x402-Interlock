import { randomBytes } from "node:crypto";
import { fromAtomic, toAtomic } from "./amount";
import { Ledger, type LedgerEvent } from "./ledger";
import { allowanceChain, type AllowanceSnapshot } from "./solana/allowance";
import { agentSolanaAddress, solanaMint } from "./solana/config";

// A task is the unit of budget. Each task is exactly one Solana Allowance (Fixed delegation):
// opened by the owner, delegated to the gate's key, revoked when the task closes.
// The ledger records that a task was opened/closed; the budget itself lives only on chain.
//
// A task budget bounds the loss. It does not detect a runaway agent: an agent that spends its
// whole budget on the wrong things stays inside the limit. Detection is a separate judgement.

const DECIMALS = 6;
const ledger = () => new Ledger();

export type TaskStatus = "active" | "closed";

export interface Task {
  task_id: string;
  purpose: string;
  budget: { amount: string; asset: string };
  expires_at: string;
  allowance: { pubkey: string; delegate: string; delegator: string; mint: string; create_tx: string };
  status: TaskStatus;
  opened_at: string;
  closed_at?: string;
  revoke_tx?: string;
}

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function fromEvents(events: LedgerEvent[]): Task | null {
  const opened = events.find((e) => e.event_type === "task_opened");
  if (!opened) return null;
  const closed = events.find((e) => e.event_type === "task_closed");
  const d = opened.data as Omit<Task, "status" | "opened_at">;
  return {
    task_id: d.task_id,
    purpose: d.purpose,
    budget: d.budget,
    expires_at: d.expires_at,
    allowance: d.allowance,
    status: closed ? "closed" : "active",
    opened_at: opened.occurred_at,
    closed_at: closed?.occurred_at,
    revoke_tx: closed ? String(closed.data.revoke_tx) : undefined,
  };
}

export function getTask(task_id: string): Task | null {
  if (!/^task_[0-9a-f]{24}$/.test(task_id)) return null;
  return fromEvents(ledger().byDecision(task_id));
}

export function listTasks(): Task[] {
  const ids = [...new Set(ledger().readAll().filter((e) => e.event_type === "task_opened").map((e) => e.decision_id))];
  return ids.map((id) => getTask(id)!).filter(Boolean).reverse();
}

/**
 * Open a task: create one Allowance on chain with the gate's key as delegate, read it back,
 * and only then record it. Callers must be the owner (see app/api/tasks).
 */
export async function openTask(input: { purpose: string; budget: { amount: string; asset?: string }; expires_at: string }, now = new Date()): Promise<Task> {
  const purpose = (input.purpose ?? "").trim();
  if (!purpose) throw new TaskError("purpose is required");
  const asset = input.budget?.asset ?? "USDC";
  if (asset !== "USDC") throw new TaskError("only USDC budgets are supported");
  let amount: bigint;
  try {
    amount = toAtomic(String(input.budget?.amount ?? ""), DECIMALS);
  } catch {
    throw new TaskError("budget.amount must be a decimal string, e.g. \"10.00\"");
  }
  if (amount <= 0n) throw new TaskError("budget.amount must be positive");
  const expires = new Date(input.expires_at);
  if (Number.isNaN(expires.getTime()) || expires <= now) throw new TaskError("expires_at must be a future ISO time");

  const chain = allowanceChain();
  const delegate = await chain.gateAddress();
  const owner = await chain.ownerAddress();
  const agent = agentSolanaAddress();
  // Delegating to the agent would let it spend the budget without passing the gate.
  if (!agent) throw new TaskError("AGENT_SOLANA_ADDRESS is not set; cannot prove the delegate is not the agent", 500);
  if (delegate === agent) throw new TaskError("refusing to delegate the allowance to the agent's key", 500);
  if (delegate === owner) throw new TaskError("gate key and owner key must differ", 500);

  const task_id = `task_${randomBytes(12).toString("hex")}`;
  const nonce = BigInt("0x" + randomBytes(8).toString("hex"));
  const expiryTs = BigInt(Math.floor(expires.getTime() / 1000));
  const created = await chain.create({ delegatee: delegate, amount, expiryTs, nonce });

  // Trust the chain, not our own request: read the allowance back and check it.
  const snap = await chain.read(created.address);
  const problem = verifyNewAllowance(snap, { delegate, owner, agent, amount, expiryTs });
  if (problem) {
    await chain.revoke(created.address).catch(() => undefined);
    throw new TaskError(`allowance verification failed: ${problem}`, 502);
  }

  const task: Task = {
    task_id,
    purpose,
    budget: { amount: fromAtomic(amount, DECIMALS), asset },
    expires_at: expires.toISOString(),
    allowance: { pubkey: created.address, delegate, delegator: owner, mint: solanaMint(), create_tx: created.signature },
    status: "active",
    opened_at: now.toISOString(),
  };
  ledger().append(task_id, "task_opened", {
    task_id,
    purpose,
    budget: task.budget,
    expires_at: task.expires_at,
    allowance: task.allowance,
    allowance_snapshot: snap,
  });
  return getTask(task_id)!;
}

export function verifyNewAllowance(
  snap: AllowanceSnapshot,
  want: { delegate: string; owner: string; agent: string; amount: bigint; expiryTs: bigint },
): string | null {
  const d = snap.decoded;
  if (!snap.exists || !d) return "allowance account not found after creation";
  if (d.delegatee === want.agent) return "delegatee is the agent's key";
  if (d.delegatee !== want.delegate) return `delegatee ${d.delegatee} is not the gate key ${want.delegate}`;
  if (d.delegator !== want.owner) return `delegator ${d.delegator} is not the owner ${want.owner}`;
  if (d.mint !== solanaMint()) return `mint ${d.mint} is not ${solanaMint()}`;
  if (BigInt(d.amount) !== want.amount) return `amount ${d.amount} is not ${want.amount}`;
  if (BigInt(d.expiry_ts) !== want.expiryTs) return `expiry ${d.expiry_ts} is not ${want.expiryTs}`;
  return null;
}

/** Close a task: revoke its Allowance on chain. Irreversible; a new task is needed to resume. */
export async function closeTask(task_id: string): Promise<Task> {
  const task = getTask(task_id);
  if (!task) throw new TaskError("unknown task", 404);
  if (task.status === "closed") throw new TaskError("task already closed", 409);
  const chain = allowanceChain();
  // The Allowance may already be gone (revoked earlier, or never cleaned up in the ledger): the
  // revoke would then fail with "Invalid account owner". Confirm on chain that there is no
  // delegation left, and close the task in the ledger without a revoke (stage 8, section 4).
  const gone = async () => {
    const snap = await chain.read(task.allowance.pubkey);
    return snap.exists ? undefined : snap;
  };
  const closeGone = (snap: AllowanceSnapshot, revoke_error?: string) => {
    ledger().append(task_id, "task_closed", { task_id, revoke_tx: null, reason: "ALLOWANCE_ALREADY_GONE", allowance: task.allowance.pubkey, allowance_snapshot: snap, ...(revoke_error ? { revoke_error } : {}) });
    return getTask(task_id)!;
  };
  const before = await gone();
  if (before) return closeGone(before);
  let signature: string;
  try {
    ({ signature } = await chain.revoke(task.allowance.pubkey));
  } catch (e) {
    const after = await gone().catch(() => undefined);
    if (after) return closeGone(after, (e as Error).message);
    throw e;
  }
  const snap = await chain
    .read(task.allowance.pubkey)
    .catch((e: Error) => ({ error: e.message }));
  ledger().append(task_id, "task_closed", { task_id, revoke_tx: signature, allowance: task.allowance.pubkey, allowance_snapshot: snap });
  return getTask(task_id)!;
}

/** The owner resumes a task stopped by TASK_CONSECUTIVE_FAILURES (stage 8). Recorded with the reason. */
export function resumeTask(task_id: string, reason: string): Task {
  const task = getTask(task_id);
  if (!task) throw new TaskError("unknown task", 404);
  if (!reason.trim()) throw new TaskError("give the reason", 400);
  ledger().append(task_id, "task_resumed", { task_id, reason });
  return task;
}

// ---------------------------------------------------------------------------
// Checks before an action / before every signature
// ---------------------------------------------------------------------------

export type TaskReason = "TASK_MISSING" | "TASK_NOT_ACTIVE" | "TASK_EXPIRED";

/** Steps 1-3: no network. */
export function checkTask(task_id: string | undefined, now = new Date()): { task?: Task; reason?: TaskReason } {
  if (!task_id) return { reason: "TASK_MISSING" };
  const task = getTask(task_id);
  if (!task) return { reason: "TASK_MISSING" };
  if (task.status !== "active") return { task, reason: "TASK_NOT_ACTIVE" };
  if (new Date(task.expires_at) <= now) return { task, reason: "TASK_EXPIRED" };
  return { task };
}

export type AllowanceReason =
  | "ALLOWANCE_UNAVAILABLE"
  | "ALLOWANCE_REVOKED"
  | "ALLOWANCE_DELEGATE_MISMATCH"
  | "ALLOWANCE_EXPIRED"
  | "ALLOWANCE_INSUFFICIENT"
  // enough on chain, but not after what the task's other unfinished payments hold (stage 8)
  | "BUDGET_RESERVED";

/**
 * Steps 4-5, run immediately before every signature (never cached): read the Allowance
 * from chain, record the slot, address and raw account data, and decide.
 */
export async function checkAllowance(
  task: Task,
  amountAtomic: bigint,
  ctx: { decision_id: string; phase: "evaluate" | "signing" },
  now = new Date(),
  /** budget held by the task's other decided-but-unfinished payments (stage 8) */
  reservedAtomic = 0n,
): Promise<{ ok: true; snapshot: AllowanceSnapshot } | { ok: false; reason: AllowanceReason; snapshot?: AllowanceSnapshot; error?: string }> {
  const chain = allowanceChain();
  let snapshot: AllowanceSnapshot;
  try {
    snapshot = await chain.read(task.allowance.pubkey);
  } catch (e) {
    const error = (e as Error).message;
    ledger().append(ctx.decision_id, "allowance_checked", { task_id: task.task_id, phase: ctx.phase, allowance: task.allowance.pubkey, ok: false, reason: "ALLOWANCE_UNAVAILABLE", error });
    return { ok: false, reason: "ALLOWANCE_UNAVAILABLE", error };
  }
  const gate = await chain.gateAddress().catch(() => task.allowance.delegate);
  const d = snapshot.decoded;
  let reason: AllowanceReason | undefined;
  if (!snapshot.exists || !d) reason = "ALLOWANCE_REVOKED";
  else if (d.delegatee !== gate || d.delegatee !== task.allowance.delegate) reason = "ALLOWANCE_DELEGATE_MISMATCH";
  else if (d.expiry_ts !== "0" && BigInt(d.expiry_ts) <= BigInt(Math.floor(now.getTime() / 1000))) reason = "ALLOWANCE_EXPIRED";
  else if (BigInt(d.amount) < amountAtomic) reason = "ALLOWANCE_INSUFFICIENT";
  else if (BigInt(d.amount) - reservedAtomic < amountAtomic) reason = "BUDGET_RESERVED";
  ledger().append(ctx.decision_id, "allowance_checked", {
    task_id: task.task_id,
    phase: ctx.phase,
    requested_atomic: amountAtomic.toString(),
    reserved_by_others_atomic: reservedAtomic.toString(),
    ok: !reason,
    reason: reason ?? null,
    snapshot,
  });
  return reason ? { ok: false, reason, snapshot } : { ok: true, snapshot };
}

/** Spent so far according to the chain (budget - remaining), or null if the chain cannot answer. */
export async function taskUsage(task: Task): Promise<{ remaining?: string; used?: string; slot?: string; error?: string }> {
  try {
    const s = await allowanceChain().read(task.allowance.pubkey);
    const budget = toAtomic(task.budget.amount, DECIMALS);
    if (!s.exists || !s.decoded) return { slot: s.slot, remaining: "0", used: undefined };
    const remaining = BigInt(s.decoded.amount);
    return { slot: s.slot, remaining: fromAtomic(remaining, DECIMALS), used: fromAtomic(budget - remaining, DECIMALS) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
