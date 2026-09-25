// End-to-end test of the gate against local HTTP servers standing in for the seller,
// Intercepta and the World Developer API. These doubles exist only in this test file,
// so the gate logic (screening, policy, ledger, human paths, signing) can be exercised
// offline. At runtime lib/intercepta.ts and lib/world.ts always call the real services.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { loadApprovalRequest } from "../lib/world";

const SELLER = "0x1111111111111111111111111111111111111111";
const RISKY = "0x2222222222222222222222222222222222222222";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const prices: Record<string, { payTo: string; amounts: string[] }> = {
  quote: { payTo: SELLER, amounts: ["10000"] },
  report: { payTo: SELLER, amounts: ["800000"] },
  dataset: { payTo: SELLER, amounts: ["2000000", "400000"] },
  risky: { payTo: RISKY, amounts: ["10000"] },
};

let seller: Server, intercepta: Server, world: Server;
let sellerUrl = "";
let interceptaDown = false;
let worldAccepts = true;
const paidBodies: unknown[] = [];

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  const dir = process.env.TEST_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "interlock-"));
  process.env.DATA_DIR = dir;
  process.env.LEDGER_PATH = path.join(dir, "ledger.jsonl");
  process.env.POLICY_PATH = path.join(dir, "policy.json");
  writeFileSync(
    process.env.POLICY_PATH,
    JSON.stringify({
      token_decimals: 6,
      allowlist: [SELLER],
      max_amount_per_payment: "1.00",
      max_amount_per_run: "3.00",
      ask_human_above: "0.50",
      repurchase_window_minutes: 10,
    }),
  );
  process.env.BUYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  process.env.INTERCEPTA_API_KEY = "test-key";
  process.env.NEXT_PUBLIC_WORLD_APP_ID = "app_test";
  process.env.WORLD_RP_ID = "rp_test";
  process.env.WORLD_SIGNING_KEY = "11".repeat(32);
  process.env.WORLD_ENVIRONMENT = "sandbox";

  seller = createServer((req, res) => {
    const name = req.url!.split("/").pop()!;
    const p = prices[name];
    const accepts = p.amounts.map((amount) => ({
      scheme: "exact",
      network: "eip155:84532" as const,
      asset: USDC,
      amount,
      payTo: p.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    }));
    const sig = req.headers["payment-signature"];
    if (!sig) {
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: sellerUrl + req.url }, accepts }), "content-type": "application/json" });
      return res.end("{}");
    }
    const payload = decodePaymentSignatureHeader(String(sig));
    paidBodies.push(payload);
    res.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: "0xtx", network: "eip155:84532", payer: "0xbuyer" }),
    });
    res.end(JSON.stringify({ served: name, amount: payload.accepted.amount }));
  });
  sellerUrl = await listen(seller);

  intercepta = createServer((req, res) => {
    if (interceptaDown) {
      res.writeHead(503);
      return res.end();
    }
    assert.equal(req.headers["x-api-key"], "test-key");
    const risky = req.url!.toLowerCase().includes(RISKY.toLowerCase());
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url!.includes("/account/")) {
      return res.end(JSON.stringify(risky ? { toxicScore: 95, traits: [{ name: "known_scammer", risk: "high" }] } : { toxicScore: 0, traits: [] }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msgRisky = body.toLowerCase().includes(RISKY.toLowerCase());
      res.end(JSON.stringify(msgRisky ? { action: "block", detectors: [{ code: "SCAM" }] } : { action: "info", detectors: [] }));
    });
  });
  process.env.INTERCEPTA_BASE_URL = await listen(intercepta);

  world = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body);
      res.writeHead(worldAccepts ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(worldAccepts ? { success: true, action: r.action, environment: r.environment, nullifier: "0x2a" } : { success: false, code: "all_verifications_failed" }));
    });
  });
  process.env.WORLD_VERIFY_BASE_URL = await listen(world);
});

after(() => {
  seller.close();
  intercepta.close();
  world.close();
});

const gate = () => import("../lib/gate");
const ev = async (name: string, run_id = "run-1") => (await gate()).evaluate({ url: `${sellerUrl}/${name}`, purpose: "test", run_id, baseUrl: "http://x" });

function proofFor(decision_id: string, nullifier = "0x2a"): IDKitResult {
  // Reads the approval request the gate stored, like the approval page does.
  const req = loadApprovalRequest(decision_id)!;
  return {
    protocol_version: "4.0",
    nonce: req.rp_context.nonce,
    action: req.action,
    environment: req.environment,
    responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(req.signal), proof: [], nullifier, issuer_schema_id: 1, expires_at_min: 0 }],
  } as unknown as IDKitResult;
}

test("scenario 1: safe small payment -> PAY, signed for exact amount", async () => {
  const v = await ev("quote");
  assert.equal(v.decision, "PAY");
  assert.equal(v.status, "PAID");
  assert.deepEqual(v.result?.body, { served: "quote", amount: "10000" });
});

test("scenario 2: Intercepta flags payTo -> BLOCK, nothing signed", async () => {
  const before = paidBodies.length;
  const v = await ev("risky");
  assert.equal(v.decision, "BLOCK");
  assert.deepEqual(v.reasons, ["SCREENING_RISKY"]);
  assert.equal(paidBodies.length, before);
});

test("Intercepta down -> BLOCK (fail closed)", async () => {
  interceptaDown = true;
  try {
    const v = await ev("quote", "run-down");
    assert.deepEqual(v.reasons, ["SCREENING_UNAVAILABLE"]);
  } finally {
    interceptaDown = false;
  }
});

test("CAP: pays the cheaper option the seller offered", async () => {
  const v = await ev("dataset", "run-cap");
  assert.equal(v.decision, "CAP");
  assert.equal(v.status, "PAID");
  assert.deepEqual(v.result?.body, { served: "dataset", amount: "400000" });
});

test("scenario 3a: high value -> ASK_HUMAN -> verified approval -> PAID", async () => {
  const g = await gate();
  const v = await ev("report", "run-3a");
  assert.equal(v.status, "AWAITING_HUMAN");
  assert.equal(v.approval_url, `http://x/approve/${v.decision_id}`);
  const { outcome, view } = await g.approve(v.decision_id, proofFor(v.decision_id));
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(view.status, "PAID");
});

test("approval replay after completion is refused", async () => {
  const g = await gate();
  const v = await ev("report", "run-replay");
  await g.approve(v.decision_id, proofFor(v.decision_id));
  const again = await g.approve(v.decision_id, proofFor(v.decision_id));
  assert.equal(again.outcome.ok, false);
});

test("scenario 3b: reject -> not paid, later approval refused", async () => {
  const g = await gate();
  const v = await ev("report", "run-3b");
  assert.equal(g.reject(v.decision_id, "owner said no").status, "HUMAN_REJECTED");
  const late = await g.approve(v.decision_id, proofFor(v.decision_id));
  assert.equal(late.outcome.ok, false);
  assert.equal(late.view.status, "HUMAN_REJECTED");
});

test("cancel -> not paid", async () => {
  const g = await gate();
  const v = await ev("report", "run-cancel");
  assert.equal(g.cancel(v.decision_id, "agent_gave_up").status, "HUMAN_CANCELLED");
});

test("expiry -> not paid, even with a valid proof", async () => {
  process.env.WORLD_APPROVAL_TTL_SECONDS = "1";
  try {
    const g = await gate();
    const v = await ev("report", "run-expire");
    const proof = proofFor(v.decision_id);
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(g.view(v.decision_id).status, "HUMAN_EXPIRED");
    assert.equal((await g.approve(v.decision_id, proof)).outcome.ok, false);
  } finally {
    delete process.env.WORLD_APPROVAL_TTL_SECONDS;
  }
});

test("World API refuses the proof -> stays pending, not paid", async () => {
  worldAccepts = false;
  try {
    const g = await gate();
    const v = await ev("report", "run-worldno");
    const r = await g.approve(v.decision_id, proofFor(v.decision_id));
    assert.equal(r.outcome.ok, false);
    assert.equal(r.view.status, "AWAITING_HUMAN");
  } finally {
    worldAccepts = true;
  }
});

test("a different person (other nullifier) cannot approve", async () => {
  const g = await gate();
  const v = await ev("report", "run-stranger");
  const r = await g.approve(v.decision_id, proofFor(v.decision_id, "0x99"));
  assert.equal(r.outcome.reason, "not_agent_owner");
});

test("repurchase inside window -> ASK_HUMAN", async () => {
  const v = await ev("quote", "run-repurchase");
  assert.equal(v.decision, "ASK_HUMAN");
  assert.ok(v.reasons.includes("REPURCHASE_IN_WINDOW"));
});

test("ledger chain intact and holds no secrets", async () => {
  const { Ledger } = await import("../lib/ledger");
  const l = new Ledger();
  assert.equal(l.verify(), -1);
  const raw = JSON.stringify(l.readAll());
  assert.ok(!raw.includes("test-key"));
  assert.ok(!raw.includes(process.env.BUYER_PRIVATE_KEY!.slice(2)));
  assert.ok(!raw.includes(process.env.WORLD_SIGNING_KEY!));
});

test("expireAllDue closes stale requests without anyone opening them", async () => {
  process.env.WORLD_APPROVAL_TTL_SECONDS = "1";
  try {
    const g = await gate();
    const v = await ev("report", "run-sweep");
    await new Promise((r) => setTimeout(r, 2100));
    g.expireAllDue();
    const { Ledger } = await import("../lib/ledger");
    const h = new Ledger().byDecision(v.decision_id).filter((e) => e.event_type === "human_verification");
    assert.equal(h.at(-1)?.data.status, "EXPIRED");
  } finally {
    delete process.env.WORLD_APPROVAL_TTL_SECONDS;
  }
});
