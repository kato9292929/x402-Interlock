import Link from "next/link";
import { connection } from "next/server";
import { expireAllDue } from "@/lib/gate";
import { decisionCards } from "@/lib/timeline";
import AutoRefresh from "./auto-refresh";

// Screen 1: decision timeline. Screen 3 (outcome) is the badge at the top of each card.
export default async function Timeline() {
  await connection();
  expireAllDue();
  const { cards, chainBrokenAt } = decisionCards();
  return (
    <>
      <AutoRefresh />
      <div className="row">
        <h1 style={{ margin: 0, fontSize: 20 }}>Decision timeline</h1>
        <span className={`badge ${chainBrokenAt === -1 ? "PAY" : "BLOCK"}`}>
          {chainBrokenAt === -1 ? "ledger hash chain intact" : `ledger chain broken at line ${chainBrokenAt + 1}`}
        </span>
      </div>
      {cards.length === 0 && <p className="muted">No payments yet. Run <code>npm run agent -- quote</code>.</p>}
      {cards.map((c) => (
        <section key={c.decision_id} className="card">
          <div className="row">
            <span className={`badge ${c.decision}`}>{c.decision ?? "…"}</span>
            <strong className={c.outcome.cls}>{c.outcome.label}</strong>
            {c.outcome.cls === "AWAITING_HUMAN" && <Link href={`/approve/${c.decision_id}`}>open approval →</Link>}
            <span className="muted" style={{ marginLeft: "auto" }}>{new Date(c.started_at).toLocaleString()}</span>
          </div>
          <dl style={{ marginTop: 8 }}>
            <dt>resource</dt><dd><code>{c.resource}</code></dd>
            <dt>purpose</dt><dd>{c.purpose}</dd>
            <dt>amount</dt><dd>{c.amount ?? "–"}</dd>
            <dt>payTo</dt><dd><code>{c.payTo ?? "–"}</code></dd>
            <dt>reason codes</dt><dd><code>{c.reasons.join(", ") || "–"}</code></dd>
            {c.screening && (
              <>
                <dt>Intercepta</dt>
                <dd>
                  <span className={`badge ${c.screening.verdict === "SAFE" ? "PAY" : "BLOCK"}`}>{c.screening.verdict}</span>
                  <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                    {c.screening.checks.map((k) => (
                      <li key={k.check}>
                        <code>{k.check}</code>: <span className={k.verdict === "SAFE" ? "PAY" : "BLOCK"}>{k.verdict}</span>
                        {k.reasons.length > 0 && <span className="muted"> — {k.reasons.join("; ")}</span>}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          <details>
            <summary>{c.events.length} ledger events</summary>
            <ol className="events">
              {c.events.map((e) => (
                <li key={e.event_id}>
                  <span className="evt">{e.event_type}</span> <span className="muted">{e.occurred_at}</span>
                  <pre>{JSON.stringify(e.data, null, 1)}</pre>
                  <span className="muted">hash {e.event_hash.slice(0, 16)}… ← prev {e.previous_event_hash?.slice(0, 16) ?? "genesis"}</span>
                </li>
              ))}
            </ol>
          </details>
        </section>
      ))}
    </>
  );
}
