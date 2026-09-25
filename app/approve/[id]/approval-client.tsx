"use client";

import { useEffect, useState } from "react";
import { IDKitRequestWidget, proofOfHuman, type IDKitErrorCodes, type IDKitResult, type RpContext } from "@worldcoin/idkit";

interface Props {
  decisionId: string;
  initialStatus: string;
  expiresAt: number;
  idkit: {
    app_id: `app_${string}`;
    action: string;
    signal: string;
    environment: "production" | "staging" | "sandbox";
    require_user_presence: boolean;
    rp_context: RpContext;
  };
}

const LABEL: Record<string, string> = {
  AWAITING_HUMAN: "Waiting for your World ID approval",
  PAID: "Approved and paid",
  PAYMENT_FAILED: "Approved, but the seller did not settle",
  HUMAN_REJECTED: "Rejected: not paid",
  HUMAN_EXPIRED: "Expired: not paid",
  HUMAN_CANCELLED: "Cancelled: not paid",
};

export default function ApprovalClient({ decisionId, initialStatus, expiresAt, idkit }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [note, setNote] = useState("");
  const [left, setLeft] = useState(() => expiresAt - Math.floor(Date.now() / 1000));
  const pending = status === "AWAITING_HUMAN";

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      const s = expiresAt - Math.floor(Date.now() / 1000);
      setLeft(s);
      if (s < 0) {
        setOpen(false);
        // The server decides expiry; reload to read its verdict.
        window.location.reload();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [pending, expiresAt]);

  async function post(path: string, body: unknown) {
    const res = await fetch(`/api/approvals/${decisionId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, json: await res.json() };
  }

  // The proof is only relayed; the server verifies it with World and decides.
  async function handleVerify(result: IDKitResult) {
    const { ok, json } = await post("verify", { result });
    setStatus(json.view?.status ?? status);
    if (!ok) {
      setNote(`Server refused the proof: ${json.reason ?? json.error}`);
      throw new Error(json.reason ?? "verification failed");
    }
  }

  async function onError(code: IDKitErrorCodes) {
    if (code === "user_rejected" || code === "verification_rejected") {
      const { json } = await post("reject", { reason: `world_app:${code}` });
      setStatus(json.status);
    } else if (code === "cancelled") {
      const { json } = await post("cancel", { reason: "world_app:cancelled" });
      setStatus(json.status);
    } else if (code !== "failed_by_host_app") {
      setNote(`World ID error: ${code}`);
    }
  }

  return (
    <section className="card">
      <p className={status} style={{ fontWeight: 700, margin: "0 0 8px" }}>
        {LABEL[status] ?? status}
        {pending && left >= 0 && <span className="muted"> · {left}s left</span>}
      </p>
      {pending && (
        <div className="row">
          <button className="primary" onClick={() => setOpen(true)}>Approve with World ID</button>
          <button className="danger" onClick={async () => setStatus((await post("reject", { reason: "owner_clicked_reject" })).json.status)}>
            Reject
          </button>
          <button onClick={async () => setStatus((await post("cancel", { reason: "owner_clicked_cancel" })).json.status)}>Cancel</button>
        </div>
      )}
      {note && <p className="muted">{note}</p>}
      <p className="muted" style={{ marginBottom: 0 }}>
        Credential requested: <code>proof_of_human</code> (Orb)
        {idkit.require_user_presence ? " with a fresh user-presence check" : ""}. The proof is bound to this exact payment.
      </p>
      <IDKitRequestWidget
        open={open}
        onOpenChange={setOpen}
        app_id={idkit.app_id}
        action={idkit.action}
        rp_context={idkit.rp_context}
        environment={idkit.environment}
        allow_legacy_proofs={false}
        require_user_presence={idkit.require_user_presence}
        action_description="Approve an agent payment"
        preset={proofOfHuman({ signal: idkit.signal })}
        handleVerify={handleVerify}
        onSuccess={() => setOpen(false)}
        onError={onError}
      />
    </section>
  );
}
