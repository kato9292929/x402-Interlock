import Link from "next/link";
import { connection } from "next/server";
import { fromAtomic, toAtomic } from "@/lib/amount";
import { expireAllDue } from "@/lib/gate";
import { Ledger } from "@/lib/ledger";
import { listTasks } from "@/lib/tasks";
import { decisionCards } from "@/lib/timeline";
import AutoRefresh from "../auto-refresh";

const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

// Tasks: each one is a Solana Allowance. Budget and "remaining" are what the chain said the
// last time the gate read it (with the slot); "spent" is the sum of payments the gate made.
export default async function TasksPage() {
  await connection();
  expireAllDue();
  const ledger = new Ledger();
  const all = ledger.readAll();
  const { cards } = decisionCards(ledger);
  const tasks = listTasks();
  return (
    <>
      <AutoRefresh />
      <h1 style={{ margin: 0, fontSize: 20 }}>Tasks</h1>
      <p className="muted">
        One task = one on-chain Allowance delegated to the gate&apos;s key. A task budget caps the loss; it does not detect a runaway agent.
      </p>
      {tasks.length === 0 && <p className="muted">No tasks yet. The owner opens one with <code>npm run task -- open</code>.</p>}
      {tasks.map((t) => {
        const paid = all.filter((e) => e.event_type === "payment_result" && e.data.task_id === t.task_id && e.data.status === "PAID");
        const spent = paid.reduce((s, e) => s + BigInt(String(e.data.amount)), 0n);
        // Last time the chain was read for this task: a gate check, or the read-back at open / close.
        const reads = all.filter(
          (e) =>
            (e.event_type === "allowance_checked" && e.data.task_id === t.task_id && e.data.snapshot) ||
            ((e.event_type === "task_opened" || e.event_type === "task_closed") && e.decision_id === t.task_id && (e.data.allowance_snapshot as { slot?: string })?.slot),
        );
        const last = reads.at(-1);
        const snap = (last?.data.snapshot ?? last?.data.allowance_snapshot) as { slot: string; exists: boolean; decoded?: { amount: string } } | undefined;
        const decisions = cards.filter((c) => c.task_id === t.task_id);
        const expired = new Date(t.expires_at) <= new Date();
        const status = t.status === "closed" ? "closed" : expired ? "expired" : "active";
        return (
          <section key={t.task_id} className="card">
            <div className="row">
              <span className={`badge ${status === "active" ? "PAY" : "BLOCK"}`}>{status}</span>
              <strong>{t.purpose}</strong>
              <span className="muted" style={{ marginLeft: "auto" }}>{t.task_id}</span>
            </div>
            <dl style={{ marginTop: 8 }}>
              <dt>budget</dt><dd>{t.budget.amount} {t.budget.asset}</dd>
              <dt>spent</dt><dd>{fromAtomic(spent, 6)} USDC in {paid.length} payment(s)</dd>
              <dt>remaining on chain</dt>
              <dd>
                {snap ? (snap.exists && snap.decoded ? `${fromAtomic(snap.decoded.amount, 6)} USDC` : "allowance closed") : "not read yet"}
                {snap && <span className="muted"> (slot {snap.slot})</span>}
                {snap?.decoded && toAtomic(t.budget.amount, 6) - BigInt(snap.decoded.amount) !== spent && (
                  <span className="muted"> · differs from gate spend: pulled but unsettled, or spent outside the gate</span>
                )}
              </dd>
              <dt>expires</dt><dd>{new Date(t.expires_at).toLocaleString()}</dd>
              <dt>allowance</dt>
              <dd>
                <a href={explorer("address", t.allowance.pubkey)} target="_blank" rel="noreferrer"><code>{t.allowance.pubkey}</code></a>
                <div className="muted">delegate (gate key) <code>{t.allowance.delegate}</code> · delegator (owner) <code>{t.allowance.delegator}</code></div>
                <div className="muted">
                  created <a href={explorer("tx", t.allowance.create_tx)} target="_blank" rel="noreferrer">tx</a>
                  {t.revoke_tx && <> · revoked <a href={explorer("tx", t.revoke_tx)} target="_blank" rel="noreferrer">tx</a></>}
                </div>
              </dd>
            </dl>
            <details open={decisions.length > 0 && decisions.length <= 8}>
              <summary>{decisions.length} decision(s) under this task</summary>
              <ol className="events">
                {decisions.map((c) => (
                  <li key={c.decision_id}>
                    <span className={`badge ${c.decision}`}>{c.decision}</span> <span className={c.outcome.cls}>{c.outcome.label}</span>
                    <div className="muted">
                      {c.action_type === "pay" ? `pay ${c.amount ?? ""} → ${c.resource}` : c.resource} · {c.reasons.join(", ")} · {new Date(c.started_at).toLocaleTimeString()}
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          </section>
        );
      })}
      <p className="muted"><Link href="/">← timeline</Link></p>
    </>
  );
}
