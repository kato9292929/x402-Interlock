import { test } from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { paymentSignal, verifyApproval, type ApprovalRequest } from "../lib/world";

// Local checks that run before the World Developer API is called.
// Every case here must be refused without a network call.
process.env.WORLD_VERIFY_BASE_URL = "http://127.0.0.1:9"; // unreachable: a passing case would fail loudly

const now = Math.floor(Date.now() / 1000);
const req: ApprovalRequest = {
  decision_id: "00000000-0000-4000-8000-000000000000",
  app_id: "app_test",
  action: "interlock-approve-payment",
  signal: paymentSignal({ decision_id: "d", payTo: "0xAb", amount: "800000", asset: "0xCd", network: "eip155:84532" }),
  environment: "sandbox",
  require_user_presence: true,
  rp_context: { rp_id: "rp_test", nonce: "0x01", created_at: now, expires_at: now + 180, signature: "0x" },
  summary: { payTo: "0xAb", amount: "800000", amount_display: "0.8 USDC", asset: "0xCd", network: "eip155:84532", resource: "r", purpose: "p" },
};
const good = {
  protocol_version: "4.0",
  nonce: "0x01",
  action: req.action,
  environment: "sandbox",
  responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(req.signal), proof: [], nullifier: "0x2a", issuer_schema_id: 1, expires_at_min: 0 }],
};
const as = (o: unknown) => o as IDKitResult;

test("signal binds payTo/amount/asset/network, case-insensitive on addresses", () => {
  assert.equal(req.signal, "d|eip155:84532|0xcd|0xab|800000");
});

test("expired request is refused", async () => {
  const r = await verifyApproval(req, as(good), (now + 181) * 1000);
  assert.equal(r.reason, "request_expired");
});

test("nonce / action / environment mismatches are refused", async () => {
  assert.equal((await verifyApproval(req, as({ ...good, nonce: "0x02" }))).reason, "nonce_mismatch");
  assert.equal((await verifyApproval(req, as({ ...good, action: "other" }))).reason, "action_mismatch");
  assert.equal((await verifyApproval(req, as({ ...good, environment: "production" }))).reason, "environment_mismatch");
});

test("proof for a different payment (signal) is refused", async () => {
  const other = hashSignal(paymentSignal({ decision_id: "d", payTo: "0xAb", amount: "1", asset: "0xCd", network: "eip155:84532" }));
  const r = await verifyApproval(req, as({ ...good, responses: [{ ...good.responses[0], signal_hash: other }] }));
  assert.equal(r.reason, "signal_mismatch");
});

test("other credential types are refused", async () => {
  const r = await verifyApproval(req, as({ ...good, responses: [{ ...good.responses[0], identifier: "passport" }] }));
  assert.equal(r.reason, "credential_not_proof_of_human");
});

test("legacy v3 results are refused", async () => {
  assert.equal((await verifyApproval(req, as({ ...good, protocol_version: "3.0" }))).reason, "unsupported_protocol_version");
});

test("valid-looking proof still needs World's verify API (unreachable here -> refused)", async () => {
  const r = await verifyApproval(req, as(good));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^world_verify_unreachable/);
});
