import { connection } from "next/server";
import { expireAllDue } from "@/lib/gate";
import { readInbox } from "@/lib/inbox";
import AutoRefresh from "../auto-refresh";

// The venue's inbox: what the recipient actually received. Only the gate delivers here, after
// judging the message (and, if needed, the owner approving it). A blocked message never appears.
export default async function InboxPage() {
  await connection();
  expireAllDue();
  const msgs = readInbox();
  return (
    <>
      <AutoRefresh />
      <h1 style={{ margin: 0, fontSize: 20 }}>Venue inbox</h1>
      <p className="muted">What the recipient received (demo channel <code>venue-inbox</code>). The agent has no access to this channel; only the gate sends here.</p>
      {msgs.length === 0 && <p className="muted">Nothing received.</p>}
      {msgs.map((m) => (
        <section className="card" key={m.message_id}>
          <dl>
            <dt>to</dt><dd><code>{m.to}</code></dd>
            <dt>received</dt><dd>{new Date(m.delivered_at).toLocaleString()}</dd>
            <dt>message</dt><dd><pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{m.body}</pre></dd>
            <dt>decision</dt><dd><code>{m.decision_id}</code></dd>
          </dl>
        </section>
      ))}
    </>
  );
}
