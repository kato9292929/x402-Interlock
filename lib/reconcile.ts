import { Ledger, type LedgerEvent } from "./ledger";
import { toAtomic } from "./amount";
import { allowanceChain } from "./solana/allowance";
import { getTask } from "./tasks";
import { unconfirmedInTask } from "./task-guard";

// Stage 8 (spec/07 section 8): settle payments whose Allowance pull timed out
// (ALLOWANCE_PULL_UNCONFIRMED). The pull's signature is not known on a timeout (the send helper
// returns it only once confirmed), so the chain is asked a different way: how much of the
// Allowance has been used, against what the ledger knows was pulled.
//
//   used on chain - pulls the ledger knows landed = 0             -> none landed: release
//   ... = the unknown pull's amount (or all of them together)     -> landed: settle as pulled
//   anything else, or another payment still running in the task   -> unclear: leave to the owner
//
// A pull that landed moved the amount into the gate's token account and the seller was not paid:
// the record says so; returning it to the owner is a separate step. A payment whose seller did
// not answer after signing (SELLER_NO_RESPONSE) cannot be settled from the Allowance: the pull is
// known, the seller's settlement is not. Those stay for the owner (task -- release).

/** A pull that never confirmed is only called "not landed" after its blockhash must have expired. */
export const NOT_LANDED_AFTER_MS = 2 * 60_000;

export interface ReconcileRow {
  task_id: string;
  decision_id: string;
  reason: string;
  amount: string;
  outcome: "PULL_LANDED" | "PULL_NOT_LANDED" | "UNCLEAR";
  detail: string;
}

const last = (own: LedgerEvent[], type: string) => own.filter((e) => e.event_type === type).at(-1);

export async function reconcileUnconfirmed(opts: { dryRun?: boolean; now?: number; decimals?: number } = {}): Promise<ReconcileRow[]> {
  const ledger = new Ledger();
  const now = opts.now ?? Date.now();
  const all = ledger.readAll();
  const rows: ReconcileRow[] = [];
  const tasks = [...new Set(all.filter((e) => e.event_type === "payment_reserved").map((e) => String(e.data.task_id)))];
  for (const task_id of tasks) {
    const unknown = unconfirmedInTask(all, task_id);
    if (!unknown.length) continue;
    const info = unknown.map((id) => {
      const own = all.filter((e) => e.decision_id === id);
      return { id, reason: String(last(own, "payment_result")!.data.reason), amount: BigInt(String(last(own, "payment_reserved")!.data.amount)), at: Date.parse(last(own, "payment_result")!.occurred_at) };
    });
    const row = (i: (typeof info)[number], outcome: ReconcileRow["outcome"], detail: string): ReconcileRow => ({ task_id, decision_id: i.id, reason: i.reason, amount: i.amount.toString(), outcome, detail });

    for (const i of info.filter((x) => x.reason !== "ALLOWANCE_PULL_UNCONFIRMED")) {
      rows.push(row(i, "UNCLEAR", "the seller did not answer after the pull: its settlement cannot be read from the Allowance; check the seller's transaction, then task -- release"));
    }
    const pulls = info.filter((x) => x.reason === "ALLOWANCE_PULL_UNCONFIRMED");
    if (!pulls.length) continue;
    const unclear = (detail: string) => pulls.forEach((i) => rows.push(row(i, "UNCLEAR", detail)));

    const task = getTask(task_id);
    if (!task) {
      unclear("task not found in the ledger");
      continue;
    }
    // Another payment of this task between reservation and result would move the numbers.
    const running = all.filter((e) => e.event_type === "payment_reserved" && e.data.task_id === task_id && !all.some((x) => x.decision_id === e.decision_id && x.event_type === "payment_result"));
    if (running.length) {
      unclear(`another payment of this task is still running (${running.map((e) => e.decision_id).join(", ")}); try again later`);
      continue;
    }
    let snap;
    try {
      snap = await allowanceChain().read(task.allowance.pubkey);
    } catch (e) {
      unclear(`the chain did not answer: ${(e as Error).message}`);
      continue;
    }
    if (!snap.exists || !snap.decoded) {
      unclear("the Allowance no longer exists, so its used amount cannot be read; check the gate's token account on an explorer");
      continue;
    }
    const decimals = opts.decimals ?? 6;
    const usedOnChain = toAtomic(task.budget.amount, decimals) - BigInt(snap.decoded.amount);
    // Pulls the ledger knows landed: every payment result with a confirmed pull, and pulls settled before.
    let known = 0n;
    for (const e of all) {
      if (e.data.task_id !== task_id) continue;
      if (e.event_type === "payment_result" && e.data.pull_tx) known += BigInt(String(e.data.amount));
      if (e.event_type === "payment_reconciled" && e.data.outcome === "PULL_LANDED") known += BigInt(String(e.data.amount));
    }
    const diff = usedOnChain - known;
    const sum = pulls.reduce((s, i) => s + i.amount, 0n);
    const evidence = `used on chain ${usedOnChain}, known pulls ${known}, unknown ${sum} (atomic), slot ${snap.slot}`;
    let outcome: ReconcileRow["outcome"] = "UNCLEAR";
    if (diff === sum) outcome = "PULL_LANDED";
    else if (diff === 0n) outcome = pulls.every((i) => now - i.at > NOT_LANDED_AFTER_MS) ? "PULL_NOT_LANDED" : "UNCLEAR";
    for (const i of pulls) {
      const detail =
        outcome === "PULL_LANDED"
          ? `${evidence}: landed. The amount is in the gate's token account; the seller was not paid.`
          : outcome === "PULL_NOT_LANDED"
            ? `${evidence}: did not land.`
            : diff === 0n
              ? `${evidence}: nothing landed yet, but the pull is under ${NOT_LANDED_AFTER_MS / 1000} s old; try again later`
              : `${evidence}: the difference does not match the unknown pulls; check the chain by hand`;
      rows.push(row(i, outcome, detail));
      if (!opts.dryRun && outcome !== "UNCLEAR") {
        ledger.append(i.id, "payment_reconciled", { task_id, outcome, amount: i.amount.toString(), used_on_chain: usedOnChain.toString(), known_pulls: known.toString(), slot: snap.slot, stranded_in_gate: outcome === "PULL_LANDED" });
      }
    }
  }
  return rows;
}
