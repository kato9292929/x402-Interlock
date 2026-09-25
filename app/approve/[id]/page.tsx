import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { view } from "@/lib/gate";
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
  return (
    <>
      <h1 style={{ fontSize: 20 }}>Approve this payment?</h1>
      <section className="card">
        <dl>
          <dt>to (payTo)</dt><dd><code>{s.payTo}</code></dd>
          <dt>amount</dt><dd><strong>{s.amount_display}</strong> <span className="muted">({s.amount} atomic, {s.network})</span></dd>
          <dt>for</dt><dd><code>{s.resource}</code></dd>
          <dt>agent says</dt><dd>{s.purpose}</dd>
          <dt>why asked</dt><dd><code>{v.reasons.join(", ")}</code></dd>
          <dt>expires</dt><dd>{new Date(req.rp_context.expires_at * 1000).toLocaleTimeString()}</dd>
        </dl>
      </section>
      <ApprovalClient
        decisionId={id}
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
