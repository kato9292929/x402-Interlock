// Tasks, Allowances and the action gate, end to end and offline.
// Test-only stand-ins: an in-memory Allowance chain (its account data is encoded with the
// Subscriptions SDK's own encoder, so the real decoder runs), a local x402 seller on Solana
// devnet, local Intercepta and World verify servers, and a stub for the final x402 signature
// (a real Solana x402 signature needs an RPC). Runtime code never uses any of these.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, getBase64Decoder, type Address } from "@solana/kit";
import { AccountDiscriminator, getFixedDelegationEncoder, SUBSCRIPTIONS_PROGRAM_ADDRESS } from "@solana/subscriptions";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { NextRequest } from "next/server";
import { setAllowanceChain, snapshotFromAccount, type AllowanceChain } from "../lib/solana/allowance";
import { setPaymentSignerForTests } from "../lib/signer";
import { loadApprovalRequest } from "../lib/world";
import { Ledger } from "../lib/ledger";
import { loadActionPolicies } from "../lib/actions";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SELLER_MAIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRICE = 300_000n; // 0.30 USDC

// ---------------------------------------------------------------------------
// in-memory Allowance chain
// ---------------------------------------------------------------------------

type Acct = { delegator: string; delegatee: string; amount: bigint; expiry: bigint };
class FakeChain implements AllowanceChain {
  accounts = new Map<string, Acct>();
  slot = 1_000n;
  reads = 0;
  failReads = false;
  createDelegateeOverride?: string;
  revoked: string[] = [];
  pulls: { allowance: string; amount: bigint }[] = [];
  constructor(
    readonly gate: string,
    readonly owner: string,
  ) {}
  async gateAddress() {
    return this.gate;
  }
  async ownerAddress() {
    return this.owner;
  }
  async create(p: { delegatee: string; amount: bigint; expiryTs: bigint; nonce: bigint }) {
    const addr = (await generateKeyPairSigner()).address;
    this.accounts.set(addr, { delegator: this.owner, delegatee: this.createDelegateeOverride ?? p.delegatee, amount: p.amount, expiry: p.expiryTs });
    return { address: addr, signature: `create_${addr.slice(0, 8)}` };
  }
  async read(allowance: string) {
    this.reads++;
    if (this.failReads) throw new Error("rpc unreachable");
    this.slot++;
    const a = this.accounts.get(allowance);
    if (!a) return snapshotFromAccount(allowance, this.slot, null);
    const bytes = getFixedDelegationEncoder().encode({
      header: {
        discriminator: AccountDiscriminator.FixedDelegation,
        version: 1,
        bump: 255,
        delegator: a.delegator as Address,
        delegatee: a.delegatee as Address,
        payer: a.delegator as Address,
        initId: 0n,
      },
      subscriptionAuthority: this.owner as Address,
      mint: MINT as Address,
      amount: a.amount,
      expiryTs: a.expiry,
    });
    return snapshotFromAccount(allowance, this.slot, { owner: SUBSCRIPTIONS_PROGRAM_ADDRESS, data_base64: getBase64Decoder().decode(bytes) });
  }
  async revoke(allowance: string) {
    this.accounts.delete(allowance);
    this.revoked.push(allowance);
    return { signature: `revoke_${allowance.slice(0, 8)}` };
  }
  async pull(allowance: string, amount: bigint) {
    const a = this.accounts.get(allowance);
    if (!a || a.amount < amount) throw new Error("insufficient allowance");
    a.amount -= amount;
    this.pulls.push({ allowance, amount });
    return { signature: `pull_${this.pulls.length}` };
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

let chain: FakeChain;
let seller: Server, intercepta: Server, world: Server;
let sellerUrl = "";
let SELLER_SOL = "";
const paid: string[] = [];
const interceptaCalls: string[] = [];
let interceptaQuickScanStatus = 200;
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  const dir = process.env.TEST_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "tasks-"));
  process.env.DATA_DIR = dir;
  process.env.LEDGER_PATH = path.join(dir, "ledger.jsonl");
  const gate = (await generateKeyPairSigner()).address;
  const owner = (await generateKeyPairSigner()).address;
  const agent = (await generateKeyPairSigner()).address;
  SELLER_SOL = (await generateKeyPairSigner()).address;
  chain = new FakeChain(gate, owner);
  setAllowanceChain(chain);
  process.env.AGENT_SOLANA_ADDRESS = agent;
  process.env.SOLANA_USDC_MINT = MINT;
  process.env.SELLER_SOLANA_PAY_TO = SELLER_SOL;
  process.env.SELLER_MAINNET_ADDRESS = SELLER_MAIN;
  // Secrets that must never reach the ledger.
  process.env.GATE_SOLANA_PRIVATE_KEY = "GateSecretKeyBase58ShouldNeverAppear";
  process.env.OWNER_SOLANA_PRIVATE_KEY = "OwnerSecretKeyBase58ShouldNeverAppear";
  process.env.AGENT_TOKEN = "agent-token-secret";
  process.env.OWNER_TOKEN = "owner-token-secret";
  process.env.INTERCEPTA_API_KEY = "intercepta-key-secret";
  process.env.SCREENING_FROM_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  process.env.NEXT_PUBLIC_WORLD_APP_ID = "app_test";
  process.env.WORLD_RP_ID = "rp_test";
  process.env.WORLD_SIGNING_KEY = "22".repeat(32);
  process.env.WORLD_ENVIRONMENT = "production";

  process.env.POLICY_PATH = path.join(dir, "policy.json");
  writeFileSync(
    process.env.POLICY_PATH,
    JSON.stringify({
      token_decimals: 6,
      allowlist: ["env:SELLER_SOLANA_PAY_TO"],
      max_amount_per_payment: "1.00",
      max_amount_per_run: "100.00",
      ask_human_above: "0.50",
      repurchase_window_minutes: 10,
      screening: { targets: [{ name: "sol", payTo: "env:SELLER_SOLANA_PAY_TO", mainnet: "env:SELLER_MAINNET_ADDRESS" }] },
    }),
  );
  process.env.SCREENING_PATH = path.join(dir, "screening.json");
  const shipped = JSON.parse(readFileSync(path.join(process.cwd(), "config", "screening.json"), "utf8"));
  writeFileSync(process.env.SCREENING_PATH, JSON.stringify({ ...shipped, token_cache_minutes: 0 }));

  seller = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const accepts = [
      { scheme: "exact", network: NETWORK as `${string}:${string}`, asset: MINT, amount: PRICE.toString(), payTo: SELLER_SOL, maxTimeoutSeconds: 60, extra: { feePayer: "PayAiFeePayer1111111111111111111111111111" } },
    ];
    const sig = req.headers["payment-signature"];
    if (!sig) {
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: sellerUrl + u.pathname + u.search }, accepts }) });
      return res.end("{}");
    }
    const p = decodePaymentSignatureHeader(String(sig));
    paid.push(u.pathname + u.search);
    res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: "soltx", network: NETWORK, payer: chain.gate }) });
    res.end(JSON.stringify({ served: u.pathname, amount: p.accepted.amount }));
  });
  sellerUrl = await listen(seller);

  intercepta = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      interceptaCalls.push(req.url!);
      if (req.url!.includes("/quick-scan") && interceptaQuickScanStatus !== 200) {
        res.writeHead(interceptaQuickScanStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Too Many Requests" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url!.includes("/account/")) return res.end(JSON.stringify({ toxicScore: 0, traits: [] }));
      if (req.url!.includes("/token-intelligence/")) return res.end(JSON.stringify({ action: "info", detectors: [] }));
      res.end(JSON.stringify({ messageType: "TransferWithAuthorization", riskGroup: "Low" }));
    });
  });
  process.env.INTERCEPTA_BASE_URL = await listen(intercepta);

  world = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, action: r.action, environment: r.environment, nullifier: "0x2a" }));
    });
  });
  process.env.WORLD_VERIFY_BASE_URL = await listen(world);

  setPaymentSignerForTests(async (paymentRequired, approved) => ({
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: approved,
    payload: { transaction: "signed-by-gate" },
  }));
});

after(() => {
  seller.close();
  intercepta.close();
  world.close();
  setAllowanceChain(undefined);
  setPaymentSignerForTests(undefined);
});

const gate = () => import("../lib/gate");
const tasks = () => import("../lib/tasks");
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
const openTask = async (amount = "1.00", expires_at = inAnHour()) =>
  (await tasks()).openTask({ purpose: "Make one music video", budget: { amount, asset: "USDC" }, expires_at });
let buyN = 0;
const pay = async (task_id?: string) =>
  (await gate()).evaluate({ url: `${sellerUrl}/sol-clip?n=${++buyN}`, purpose: "clip", task_id, baseUrl: "http://x" });
const act = async (task_id: string | undefined, action_type: string, payload: unknown = { description: "test" }) =>
  (await gate()).evaluateAction({ task_id, action_type, payload, baseUrl: "http://x" });

function proofFor(decision_id: string): IDKitResult {
  const req = loadApprovalRequest(decision_id)!;
  return {
    protocol_version: "4.0",
    nonce: req.rp_context.nonce,
    action: req.action,
    environment: req.environment,
    responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(req.signal), proof: [], nullifier: "0x2a", issuer_schema_id: 1, expires_at_min: 0 }],
  } as unknown as IDKitResult;
}

// ---------------------------------------------------------------------------
// task issuance: owner only, delegate = gate key
// ---------------------------------------------------------------------------

test("AGENT_TOKEN cannot open, close or list tasks; OWNER_TOKEN can open", async () => {
  const { POST, GET } = await import("../app/api/tasks/route");
  const body = JSON.stringify({ purpose: "p", budget: { amount: "1.00" }, expires_at: inAnHour() });
  const asAgent = new NextRequest("http://x/api/tasks", { method: "POST", body, headers: { authorization: "Bearer agent-token-secret" } });
  assert.equal((await POST(asAgent)).status, 401);
  assert.equal((await GET(new NextRequest("http://x/api/tasks", { headers: { authorization: "Bearer agent-token-secret" } }))).status, 401);
  const close = await import("../app/api/tasks/[id]/close/route");
  const r = await close.POST(new NextRequest("http://x/api/tasks/task_000000000000000000000000/close", { method: "POST", headers: { authorization: "Bearer agent-token-secret" } }), {
    params: Promise.resolve({ id: "task_000000000000000000000000" }),
  });
  assert.equal(r.status, 401);
  const asOwner = new NextRequest("http://x/api/tasks", { method: "POST", body, headers: { authorization: "Bearer owner-token-secret" } });
  const ok = await POST(asOwner);
  assert.equal(ok.status, 201);
  const t = await ok.json();
  assert.equal(t.status, "active");
  assert.equal(t.allowance.delegate, chain.gate);
});

test("owner token equal to agent token authorizes nobody", async () => {
  const { POST } = await import("../app/api/tasks/route");
  process.env.OWNER_TOKEN = "agent-token-secret";
  try {
    const r = await POST(new NextRequest("http://x/api/tasks", { method: "POST", body: "{}", headers: { authorization: "Bearer agent-token-secret" } }));
    assert.equal(r.status, 401);
  } finally {
    process.env.OWNER_TOKEN = "owner-token-secret";
  }
});

test("the allowance's delegate is verified to be the gate key (read back from chain)", async () => {
  const t = await openTask();
  const snap = (await chain.read(t.allowance.pubkey)).decoded!;
  assert.equal(snap.delegatee, chain.gate);
  assert.equal(t.allowance.delegate, chain.gate);
  assert.equal(snap.amount, "1000000");
});

test("issuance fails if the chain shows the agent's key as delegate (and the allowance is revoked)", async () => {
  chain.createDelegateeOverride = process.env.AGENT_SOLANA_ADDRESS;
  const before = chain.revoked.length;
  try {
    await assert.rejects(openTask(), /delegatee is the agent's key/);
    assert.equal(chain.revoked.length, before + 1);
  } finally {
    chain.createDelegateeOverride = undefined;
  }
});

test("issuance fails if the gate key is the agent's key", async () => {
  const prev = process.env.AGENT_SOLANA_ADDRESS;
  process.env.AGENT_SOLANA_ADDRESS = chain.gate;
  try {
    await assert.rejects(openTask(), /refusing to delegate the allowance to the agent's key/);
  } finally {
    process.env.AGENT_SOLANA_ADDRESS = prev;
  }
});

// ---------------------------------------------------------------------------
// payments under a task
// ---------------------------------------------------------------------------

test("within budget: paid automatically; allowance read before evaluate and again before signing", async () => {
  const t = await openTask("1.00");
  const readsBefore = chain.reads;
  const v = await pay(t.task_id);
  assert.equal(v.status, "PAID", JSON.stringify(v));
  assert.equal(v.task_id, t.task_id);
  assert.equal(chain.reads - readsBefore, 2); // evaluate + signing
  assert.equal(chain.pulls.at(-1)?.amount, PRICE);
  const checks = new Ledger().byDecision(v.decision_id).filter((e) => e.event_type === "allowance_checked");
  assert.deepEqual(checks.map((c) => c.data.phase), ["evaluate", "signing"]);
  for (const c of checks) {
    const s = c.data.snapshot as { slot: string; address: string; data_base64: string };
    assert.match(s.slot, /^\d+$/);
    assert.equal(s.address, t.allowance.pubkey);
    assert.ok(s.data_base64.length > 100);
  }
  assert.notEqual((checks[0].data.snapshot as { slot: string }).slot, (checks[1].data.snapshot as { slot: string }).slot);
});

test("Solana: Scan Message is not sent (no EIP-712 to screen); recorded as skipped with a reason code", async () => {
  const t = await openTask("1.00");
  const from = interceptaCalls.length;
  const v = await pay(t.task_id);
  assert.equal(v.status, "PAID", JSON.stringify(v));
  const calls = interceptaCalls.slice(from);
  assert.ok(calls.some((u) => u.includes("/quick-scan")));
  assert.ok(!calls.some((u) => u.includes("/analysis/signature")), calls.join(" "));
  assert.ok(v.reasons.includes("SCAN_MESSAGE_NOT_APPLICABLE_SOLANA"));
  assert.ok(v.screening?.some((c) => c.check === "scan_message" && c.verdict === "SKIPPED"));
  const sr = new Ledger().byDecision(v.decision_id).find((e) => e.event_type === "screening_result")!;
  assert.deepEqual((sr.data.skipped as { code: string }[]).map((x) => x.code), ["SCAN_MESSAGE_NOT_APPLICABLE_SOLANA"]);
  assert.ok(!(sr.data.checks as { check: string }[]).some((c) => c.check === "scan_message"));
});

test("Intercepta 429 -> BLOCK SCREENING_UNAVAILABLE, and the reply names the check and the status", async () => {
  const t = await openTask("1.00");
  interceptaQuickScanStatus = 429;
  try {
    const v = await pay(t.task_id);
    assert.equal(v.status, "BLOCKED");
    assert.ok(v.reasons.includes("SCREENING_UNAVAILABLE"));
    const q = v.screening?.find((c) => c.check === "quick_scan_address");
    assert.equal(q?.http_status, 429);
    assert.match(q!.reasons.join(" "), /rate limit reached \(HTTP 429\)/);
  } finally {
    interceptaQuickScanStatus = 200;
  }
});

test("budget used up: stops with ALLOWANCE_INSUFFICIENT (0.30 x 3 of 1.00, 4th blocked)", async () => {
  const t = await openTask("1.00");
  for (let i = 0; i < 3; i++) assert.equal((await pay(t.task_id)).status, "PAID");
  const v = await pay(t.task_id);
  assert.equal(v.status, "BLOCKED");
  assert.deepEqual(v.reasons, ["ALLOWANCE_INSUFFICIENT"]);
});

test("no task_id on a Solana payment -> BLOCK TASK_MISSING", async () => {
  const v = await pay(undefined);
  assert.deepEqual(v.reasons, ["TASK_MISSING"]);
});

test("closed task -> BLOCK TASK_NOT_ACTIVE, and the allowance is revoked on chain", async () => {
  const t = await openTask();
  const closed = await (await tasks()).closeTask(t.task_id);
  assert.equal(closed.status, "closed");
  assert.equal((await chain.read(t.allowance.pubkey)).exists, false);
  const v = await pay(t.task_id);
  assert.deepEqual(v.reasons, ["TASK_NOT_ACTIVE"]);
  await assert.rejects((await tasks()).closeTask(t.task_id), /already closed/);
});

test("expired task -> BLOCK TASK_EXPIRED", async () => {
  const t = await openTask("1.00", new Date(Date.now() + 1500).toISOString());
  await new Promise((r) => setTimeout(r, 1700));
  assert.deepEqual((await pay(t.task_id)).reasons, ["TASK_EXPIRED"]);
});

test("allowance unreadable -> BLOCK ALLOWANCE_UNAVAILABLE (fail closed)", async () => {
  const t = await openTask();
  chain.failReads = true;
  try {
    assert.deepEqual((await pay(t.task_id)).reasons, ["ALLOWANCE_UNAVAILABLE"]);
  } finally {
    chain.failReads = false;
  }
});

test("allowance revoked on chain while the task is still open -> BLOCK ALLOWANCE_REVOKED", async () => {
  const t = await openTask();
  await chain.revoke(t.allowance.pubkey);
  assert.deepEqual((await pay(t.task_id)).reasons, ["ALLOWANCE_REVOKED"]);
});

test("checked again at signing: task closed while waiting for approval -> not paid", async () => {
  const t = await openTask("1.00");
  const prevPolicy = process.env.ACTIONS_PATH;
  process.env.ACTIONS_PATH = path.join(process.env.DATA_DIR!, "actions-pay-ask.json");
  writeFileSync(process.env.ACTIONS_PATH, JSON.stringify({ pay: "ask_human" }));
  try {
    const v = await pay(t.task_id);
    assert.equal(v.status, "AWAITING_HUMAN");
    assert.ok(v.reasons.includes("ACTION_ASK_HUMAN"));
    await (await tasks()).closeTask(t.task_id);
    const pullsBefore = chain.pulls.length;
    const { view } = await (await gate()).approve(v.decision_id, proofFor(v.decision_id));
    assert.equal(view.status, "BLOCKED");
    assert.ok(view.reasons.includes("TASK_NOT_ACTIVE"));
    assert.equal(chain.pulls.length, pullsBefore);
  } finally {
    process.env.ACTIONS_PATH = prevPolicy;
  }
});

test("checked again at signing: budget spent by others while waiting -> ALLOWANCE_INSUFFICIENT at signing", async () => {
  const t = await openTask("0.50");
  process.env.ACTIONS_PATH = path.join(process.env.DATA_DIR!, "actions-pay-ask.json");
  try {
    const v = await pay(t.task_id);
    assert.equal(v.status, "AWAITING_HUMAN");
    await chain.pull(t.allowance.pubkey, 300_000n); // someone else used the budget
    const { view } = await (await gate()).approve(v.decision_id, proofFor(v.decision_id));
    assert.equal(view.status, "BLOCKED");
    assert.ok(view.reasons.includes("ALLOWANCE_INSUFFICIENT"));
    const signing = new Ledger().byDecision(v.decision_id).filter((e) => e.event_type === "allowance_checked" && e.data.phase === "signing");
    assert.equal(signing.length, 1);
  } finally {
    delete process.env.ACTIONS_PATH;
  }
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

test("default policies: impersonate is deny, commit/disclose ask_human, pay allow", () => {
  const p = loadActionPolicies(path.join(process.cwd(), "config", "actions.json"));
  assert.deepEqual(p, { pay: "allow", commit: "ask_human", disclose: "ask_human", impersonate: "deny" });
});

test("each action type follows its policy (Muse: zero money, still stopped)", async () => {
  const t = await openTask();
  const disclose = await act(t.task_id, "disclose", { description: "share home address with the venue", address: "1-2-3 Jingumae, Shibuya" });
  assert.equal(disclose.decision, "ASK_HUMAN");
  assert.equal(disclose.status, "AWAITING_HUMAN");
  const commit = await act(t.task_id, "commit", { description: "agree to a 30% discount", discount_pct: 30 });
  assert.equal(commit.decision, "ASK_HUMAN");
  const imp = await act(t.task_id, "impersonate", { description: "post as the owner", text: "Hi, it's me" });
  assert.equal(imp.decision, "DENY");
  assert.equal(imp.status, "DENIED");
  assert.equal((await pay(t.task_id)).status, "PAID");
});

test("notify: allowed, flagged for the owner", async () => {
  const t = await openTask();
  process.env.ACTIONS_PATH = path.join(process.env.DATA_DIR!, "actions-notify.json");
  writeFileSync(process.env.ACTIONS_PATH, JSON.stringify({ commit: "notify" }));
  try {
    const v = await act(t.task_id, "commit", { description: "confirm Friday 3pm" });
    assert.equal(v.status, "ALLOWED");
    assert.equal(v.notify, true);
    assert.deepEqual(v.reasons, ["ACTION_NOTIFY"]);
  } finally {
    delete process.env.ACTIONS_PATH;
  }
});

test("ask_human action: approved with World ID -> APPROVED (the agent performs it, not the gate)", async () => {
  const t = await openTask();
  const v = await act(t.task_id, "disclose", { description: "share phone number" });
  const { view } = await (await gate()).approve(v.decision_id, proofFor(v.decision_id));
  assert.equal(view.status, "APPROVED");
});

test("ask_human action: rejected -> HUMAN_REJECTED", async () => {
  const t = await openTask();
  const v = await act(t.task_id, "commit", { description: "agree to price" });
  assert.equal((await gate()).reject(v.decision_id, "no").status, "HUMAN_REJECTED");
});

test("deny cannot be overridden by a human approval", async () => {
  const t = await openTask();
  const v = await act(t.task_id, "impersonate", { description: "speak as owner" });
  assert.equal(v.status, "DENIED");
  assert.equal(loadApprovalRequest(v.decision_id), null);
  const fakeProof = { protocol_version: "4.0", nonce: "0x01", action: "interlock-approve-payment", environment: "production", responses: [] } as unknown as IDKitResult;
  await assert.rejects((await gate()).approve(v.decision_id, fakeProof), /unknown decision/);
  assert.equal((await gate()).view(v.decision_id).status, "DENIED");
});

test("actions on a closed task are blocked", async () => {
  const t = await openTask();
  await (await tasks()).closeTask(t.task_id);
  const v = await act(t.task_id, "commit");
  assert.equal(v.status, "BLOCKED");
  assert.deepEqual(v.reasons, ["TASK_NOT_ACTIVE"]);
});

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// messages sent through the gate (deterministic content check)
// ---------------------------------------------------------------------------

const HOME = "〒150-0001 東京都渋谷区神宮前1丁目2番3号";
const MUSE = "Thanks! The owner will meet you at 神宮前１－２－３ (〒150-0001) on Saturday.";
const send = async (task_id: string | undefined, body: string, declared_type?: string) =>
  (await gate()).sendMessage({ task_id, channel: "venue-inbox", to: "venue@example.com", body, declared_type, baseUrl: "http://x" });
const inboxBodies = async () => (await import("../lib/inbox")).readInbox().map((m) => m.body);
let protectedRegistered = false;
async function registerHome() {
  if (protectedRegistered) return;
  const { addProtected } = await import("../lib/protect");
  addProtected("address", "home", HOME);
  addProtected("phone", "mobile", "090-1234-5678");
  protectedRegistered = true;
}

test("Muse: the agent declares nothing, the gate finds the owner's address and holds the message; rejected -> never delivered", async () => {
  await registerHome();
  const t = await openTask("1.00");
  const v = await send(t.task_id, MUSE);
  assert.equal(v.status, "AWAITING_HUMAN", JSON.stringify(v));
  assert.equal(v.decision, "ASK_HUMAN");
  assert.ok(v.reasons.includes("CONTENT_PROTECTED_MATCH"));
  const home = v.detected?.find((d) => d.field === "owner.home");
  assert.deepEqual(home?.parts, ["postal_code", "street_number", "locality"]);
  assert.ok(!(await inboxBodies()).includes(MUSE));
  const g = await gate();
  assert.equal(g.reject(v.decision_id, "owner_clicked_reject").status, "HUMAN_REJECTED");
  assert.ok(!(await inboxBodies()).includes(MUSE));
  const sent = new Ledger().byDecision(v.decision_id).find((e) => e.event_type === "action_sent");
  assert.equal(sent?.data.status, "NOT_SENT");
  assert.equal(sent?.data.reason, "HUMAN_REJECTED");
});

test("approved with World ID -> the gate delivers exactly that text; an edited text afterwards is a new decision", async () => {
  await registerHome();
  const t = await openTask("1.00");
  const body = "See you at 神宮前1-2-3, ring twice.";
  const v = await send(t.task_id, body);
  assert.equal(v.status, "AWAITING_HUMAN");
  const { view } = await (await gate()).approve(v.decision_id, proofFor(v.decision_id));
  assert.equal(view.status, "SENT");
  assert.ok(view.message_id);
  assert.ok((await inboxBodies()).includes(body));
  // The approval covers that exact message only.
  const edited = await send(t.task_id, body + " Door code 4421.");
  assert.notEqual(edited.decision_id, v.decision_id);
  assert.equal(edited.status, "AWAITING_HUMAN");
  assert.ok(!(await inboxBodies()).includes(body + " Door code 4421."));
  const again = await send(t.task_id, body);
  assert.equal(again.status, "AWAITING_HUMAN"); // resending the approved text needs a new approval too
});

test("a held message changed before approval is not sent (MESSAGE_CHANGED)", async () => {
  await registerHome();
  const t = await openTask("1.00");
  const v = await send(t.task_id, "My number is 090 1234 5678");
  assert.ok(v.detected?.some((d) => d.field === "owner.mobile"));
  const f = path.join(process.env.DATA_DIR!, "pending", `${v.decision_id}.json`);
  const p = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...p, body: "My number is 080 0000 0000" }));
  const { view } = await (await gate()).approve(v.decision_id, proofFor(v.decision_id));
  assert.notEqual(view.status, "SENT");
  const sent = new Ledger().byDecision(v.decision_id).find((e) => e.event_type === "action_sent");
  assert.equal(sent?.data.reason, "MESSAGE_CHANGED");
  assert.ok(!(await inboxBodies()).some((b) => b.includes("080 0000 0000")));
});

test("nothing found -> sent automatically; unregistered phone -> held (pattern); declared types only add", async () => {
  await registerHome();
  const t = await openTask("1.00");
  const clean = await send(t.task_id, "Thanks, Saturday at 18:00 works. Price 1-2 USDC is fine.");
  assert.equal(clean.status, "SENT", JSON.stringify(clean));
  assert.ok(clean.reasons.includes("CONTENT_NONE_DETECTED"));
  const pattern = await send(t.task_id, "Call the manager at 03-1111-2222");
  assert.equal(pattern.status, "AWAITING_HUMAN");
  assert.ok(pattern.reasons.includes("CONTENT_PATTERN_MATCH"));
  const promise = await send(t.task_id, "Fine.", "commit");
  assert.equal(promise.status, "AWAITING_HUMAN");
  assert.ok(promise.reasons.includes("DECLARED_TYPE"));
  const asOwner = await send(t.task_id, "Hello from the owner", "impersonate");
  assert.equal(asOwner.status, "DENIED");
  assert.ok(!(await inboxBodies()).includes("Hello from the owner"));
  // Declaring "commit" on a message with the address does not loosen the disclose policy.
  const mixed = await send(t.task_id, MUSE, "commit");
  assert.equal(mixed.status, "AWAITING_HUMAN");
  assert.ok(mixed.reasons.includes("CONTENT_PROTECTED_MATCH"));
});

test("send on a closed task is blocked and not delivered; /api/act/send needs the agent token", async () => {
  const t = await openTask("1.00");
  await (await tasks()).closeTask(t.task_id);
  const v = await send(t.task_id, "closed task message");
  assert.equal(v.status, "BLOCKED");
  assert.ok(v.reasons.includes("TASK_NOT_ACTIVE"));
  assert.ok(!(await inboxBodies()).includes("closed task message"));
  const { POST } = await import("../app/api/act/send/route");
  const body = JSON.stringify({ task_id: t.task_id, channel: "venue-inbox", to: "v", body: "x" });
  assert.equal((await POST(new NextRequest("http://x/api/act/send", { method: "POST", body, headers: { authorization: "Bearer owner-token-secret" } }))).status, 401);
  assert.equal((await POST(new NextRequest("http://x/api/act/send", { method: "POST", body: JSON.stringify({ channel: "email", to: "v", body: "x" }), headers: { authorization: "Bearer agent-token-secret" } }))).status, 400);
});

test("ledger: new events are in the hash chain, task_id on payment events, no secrets or raw payloads", async () => {
  const l = new Ledger();
  assert.equal(l.verify(), -1);
  const all = l.readAll();
  for (const type of ["task_opened", "task_closed", "action_judged", "action_sent", "allowance_checked"]) {
    assert.ok(all.some((e) => e.event_type === type), type);
  }
  const taskIds = new Set(all.filter((e) => e.event_type === "task_opened").map((e) => e.decision_id));
  const payEvents = all.filter((e) => ["payment_candidate", "screening_result", "gate_decision", "payment_result"].includes(e.event_type));
  assert.ok(payEvents.length > 0);
  for (const e of payEvents) assert.ok("task_id" in e.data, `${e.event_type} lacks task_id`);
  assert.ok(payEvents.some((e) => taskIds.has(String(e.data.task_id))));
  const raw = readFileSync(l.file, "utf8");
  for (const secret of [
    "GateSecretKeyBase58ShouldNeverAppear",
    "OwnerSecretKeyBase58ShouldNeverAppear",
    "agent-token-secret",
    "owner-token-secret",
    "intercepta-key-secret",
    "1-2-3 Jingumae",
    "Hi, it's me",
    "神宮前",
    "150-0001",
    "1234-5678",
    "venue@example.com",
    "ring twice",
  ]) {
    assert.ok(!raw.includes(secret), `ledger contains ${secret}`);
  }
});
