import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { heldMessage, view } from "@/lib/gate";
import { loadApprovalRequest } from "@/lib/world";
import ApprovalClient from "./approval-client";

// Screen 2: the owner sees exactly what they are approving, then proves with World ID.
export default async function ApprovePage({ params }: PageProps<"/approve/[id]">) {
  await connection();
  const { id } = await params;
  const req = loadApprovalRequest(id);
  if (!req) notFound();
  const v = view(id);
  const s = req.summary;
  const isAction = s.network === "interlock:action";
  const msg = heldMessage(id);
  return (
    <>
      {msg ? (
        <>
          <h1 style={{ fontSize: 20 }}>Send this message?</h1>
          <section className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              The agent asked the gate to send this. The gate found the items below in it. If you approve, the gate sends
              exactly this text to this recipient; any change is a new request.
            </p>
            <dl>
              <dt>to</dt><dd><code>{msg.to}</code> <span className="muted">via {msg.channel}</span></dd>
              <dt>message</dt><dd><pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{msg.body}</pre></dd>
              <dt>found</dt>
              <dd>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {msg.detected.map((d) => (
                    <li key={d.field}>
                      <strong>{d.field}</strong> <span className="muted">({d.source === "protected" ? "your registered data" : "looks like personal data"}: {d.parts.join(", ")})</span>
                    </li>
                  ))}
                  {!msg.detected.length && <li className="muted">nothing (asked because of the agent&apos;s declared type)</li>}
                </ul>
              </dd>
              <dt>bound to</dt><dd><code>sha256 {s.asset.slice(0, 16)}…</code> <span className="muted">channel + recipient + text</span></dd>
              <dt>task</dt><dd><code>{v.task_id ?? "-"}</code></dd>
              <dt>why asked</dt><dd><code>{v.reasons.join(", ")}</code></dd>
              <dt>expires</dt><dd>{new Date(req.rp_context.expires_at * 1000).toLocaleTimeString()}</dd>
            </dl>
          </section>
        </>
      ) : isAction ? (
        <>
          <h1 style={{ fontSize: 20 }}>Allow this action?</h1>
          <section className="card">
            <dl>
              <dt>action</dt><dd><strong>{s.resource}</strong> <span className="muted">(no money moves)</span></dd>
              <dt>agent says</dt><dd>{s.purpose}</dd>
              <dt>payload</dt><dd><code>sha256 {s.asset.slice(0, 16)}…</code> <span className="muted">your approval is bound to this exact payload</span></dd>
              <dt>task</dt><dd><code>{v.task_id ?? "-"}</code></dd>
              <dt>why asked</dt><dd><code>{v.reasons.join(", ")}</code></dd>
              <dt>expires</dt><dd>{new Date(req.rp_context.expires_at * 1000).toLocaleTimeString()}</dd>
            </dl>
          </section>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 20 }}>Approve this payment?</h1>
          <section className="card">
            <dl>
              <dt>to (payTo)</dt><dd><code>{s.payTo}</code></dd>
              <dt>amount</dt><dd><strong>{s.amount_display}</strong> <span className="muted">({s.amount} atomic, {s.network})</span></dd>
              <dt>for</dt><dd><code>{s.resource}</code></dd>
              <dt>agent says</dt><dd>{s.purpose}</dd>
              {v.task_id && (<><dt>task</dt><dd><code>{v.task_id}</code></dd></>)}
              <dt>why asked</dt><dd><code>{v.reasons.join(", ")}</code></dd>
              <dt>expires</dt><dd>{new Date(req.rp_context.expires_at * 1000).toLocaleTimeString()}</dd>
            </dl>
          </section>
        </>
      )}
      <ApprovalClient
        decisionId={id}
        isAction={isAction}
        initialStatus={v.status}
        expiresAt={req.rp_context.expires_at}
        idkit={{
          app_id: req.app_id as `app_${string}`,
          action: req.action,
          signal: req.signal,
          environment: req.environment as "production" | "staging" | "sandbox",
          require_user_presence: req.require_user_presence,
          rp_context: req.rp_context,
        }}
      />
      <p className="muted"><Link href="/">← timeline</Link></p>
    </>
  );
}
