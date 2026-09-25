import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, type Policy, type PaymentOption, type RunContext, type Screening } from "../lib/policy";

const SELLER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const policy: Policy = {
  token_decimals: 6,
  allowlist: [SELLER],
  max_amount_per_payment: "1.00",
  max_amount_per_run: "3.00",
  ask_human_above: "0.50",
  repurchase_window_minutes: 10,
};
const opt = (amount: string, payTo = SELLER): PaymentOption => ({
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo,
  amount,
});
const safe: Screening = { verdict: "SAFE", reasons: [] };
const now = new Date("2026-09-26T00:00:00Z");
const ctx: RunContext = { spentAtomic: 0n, now };
const run = (options: PaymentOption[], s = safe, c = ctx) =>
  evaluatePolicy(policy, { resource: "/api/quote", options }, s, c);

test("small safe payment -> PAY", () => {
  assert.deepEqual(run([opt("10000")]).decision, "PAY");
});

test("risky screening -> BLOCK, even if allowlisted", () => {
  const r = run([opt("10000")], { verdict: "RISKY", reasons: ["sanctioned"] });
  assert.equal(r.decision, "BLOCK");
  assert.deepEqual(r.reasons, ["SCREENING_RISKY"]);
});

test("screening unavailable -> BLOCK (fail closed)", () => {
  assert.deepEqual(run([opt("10000")], { verdict: "UNAVAILABLE", reasons: [] }).reasons, ["SCREENING_UNAVAILABLE"]);
});

test("payTo outside allowlist -> BLOCK", () => {
  assert.deepEqual(run([opt("10000", STRANGER)]).reasons, ["PAYTO_NOT_ALLOWLISTED"]);
});

test("allowlist match is case-insensitive", () => {
  assert.equal(run([opt("10000", SELLER.toUpperCase().replace("0X", "0x"))]).decision, "PAY");
});

test("over per-payment limit with cheaper option -> CAP", () => {
  const r = run([opt("2000000"), opt("400000"), opt("100000")]);
  assert.equal(r.decision, "CAP");
  assert.equal(r.selected?.amount, "400000");
});

test("over per-payment limit, no cheaper option -> BLOCK", () => {
  assert.deepEqual(run([opt("2000000")]).reasons, ["PER_PAYMENT_LIMIT_NO_CAP"]);
});

test("run limit -> BLOCK", () => {
  const r = run([opt("100000")], safe, { spentAtomic: 2_950_000n, now });
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.reasons.includes("RUN_LIMIT_EXCEEDED"));
});

test("above ask_human_above -> ASK_HUMAN", () => {
  const r = run([opt("800000")]);
  assert.equal(r.decision, "ASK_HUMAN");
  assert.deepEqual(r.reasons, ["ABOVE_HUMAN_THRESHOLD"]);
});

test("repurchase inside window -> ASK_HUMAN", () => {
  const r = run([opt("10000")], safe, { spentAtomic: 0n, now, lastPurchaseAt: new Date(now.getTime() - 60_000) });
  assert.deepEqual(r.reasons, ["REPURCHASE_IN_WINDOW"]);
});

test("repurchase outside window -> PAY", () => {
  const r = run([opt("10000")], safe, { spentAtomic: 0n, now, lastPurchaseAt: new Date(now.getTime() - 11 * 60_000) });
  assert.equal(r.decision, "PAY");
});

test("capped amount still above human threshold -> ASK_HUMAN with both reasons", () => {
  const r = run([opt("2000000"), opt("900000")]);
  assert.equal(r.decision, "ASK_HUMAN");
  assert.deepEqual(r.reasons, ["PER_PAYMENT_LIMIT_CAPPED", "ABOVE_HUMAN_THRESHOLD"]);
  assert.equal(r.selected?.amount, "900000");
});
