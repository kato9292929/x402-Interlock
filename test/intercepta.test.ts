import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretAddress, interpretSignature, interpretToken } from "../lib/intercepta";
import { loadScreeningConfig, rulesFrom } from "../lib/screening";

// Parsing rules only, run against the real config/screening.json.
// The API itself is never mocked at runtime.
const cfg = loadScreeningConfig();
const rules = rulesFrom(cfg);

// traits[].name enum of ToxicScoreShortResponseV2 (spec/04-intercepta-official-spec.md)
const ALL_TRAITS = [
  "known_scammer", "initiator_scam_transactions", "sanction_address_communication", "suspicious_dex_pair_deployer",
  "suspicious_deployer", "attack_money_target", "zero_address_risk", "sanction_address", "fake_phishing_transfer",
  "non_kyc_transfers", "mixer_transfers", "fake_phishing_contract_communication", "rug_pull", "rug_pull_trader", "blacklist",
];

test("config classifies every documented trait exactly once", () => {
  const classified = [...cfg.address.block_traits, ...cfg.address.ask_human_traits];
  assert.equal(classified.length, 15);
  assert.deepEqual([...classified].sort(), [...ALL_TRAITS].sort());
});

test("address: no traits -> SAFE, whatever toxicScore says", () => {
  assert.equal(interpretAddress({ toxicScore: 0, traits: [] }, rules.address).verdict, "SAFE");
  // toxicScore never decides on its own: no published threshold.
  const r = interpretAddress({ toxicScore: 87, traits: [] }, rules.address);
  assert.equal(r.verdict, "SAFE");
  assert.ok(r.reasons.includes("toxicScore=87 (informational)"));
});

test("address: theft/sanction traits -> RISKY (BLOCK)", () => {
  for (const name of ["known_scammer", "sanction_address", "blacklist", "rug_pull", "attack_money_target"]) {
    const r = interpretAddress({ toxicScore: 10, traits: [{ name, risk: 90, txsCount: 3, description: "d" }] }, rules.address);
    assert.equal(r.verdict, "RISKY", name);
    assert.ok(r.reasons.some((x) => x.startsWith(name)));
  }
});

test("address: suspicious-but-not-conclusive traits -> CAUTION (ASK_HUMAN)", () => {
  for (const name of ["mixer_transfers", "non_kyc_transfers", "suspicious_deployer", "zero_address_risk", "rug_pull_trader"]) {
    assert.equal(interpretAddress({ toxicScore: 5, traits: [{ name }] }, rules.address).verdict, "CAUTION", name);
  }
});

test("address: a BLOCK trait wins over a CAUTION trait", () => {
  const r = interpretAddress({ toxicScore: 5, traits: [{ name: "mixer_transfers" }, { name: "sanction_address" }] }, rules.address);
  assert.equal(r.verdict, "RISKY");
});

test("address: unknown trait name or missing traits[] -> UNAVAILABLE (fail closed)", () => {
  assert.equal(interpretAddress({ toxicScore: 0, traits: [{ name: "brand_new_trait" }] }, rules.address).verdict, "UNAVAILABLE");
  assert.equal(interpretAddress({ toxicScore: 0 }, rules.address).verdict, "UNAVAILABLE");
  assert.equal(interpretAddress("<html>", rules.address).verdict, "UNAVAILABLE");
});

test("token: follows the vendor's recommended action", () => {
  const body = (action: string) => ({ riskScore: 1, riskLevel: "neutral", category: "info", trust: "whitelist", action, detectors: [] });
  assert.equal(interpretToken(body("info"), rules.token).verdict, "SAFE");
  assert.equal(interpretToken(body("warn"), rules.token).verdict, "CAUTION");
  const b = interpretToken({ ...body("block"), detectors: [{ code: "FAKE_TOKEN", description: "impersonates USDC" }] }, rules.token);
  assert.equal(b.verdict, "RISKY");
  assert.ok(b.reasons.includes("FAKE_TOKEN: impersonates USDC"));
});

test("token: missing or unknown action -> UNAVAILABLE", () => {
  assert.equal(interpretToken({ riskLevel: "high" }, rules.token).verdict, "UNAVAILABLE");
  assert.equal(interpretToken({ action: "something" }, rules.token).verdict, "UNAVAILABLE");
});

test("scan message: verdict from riskGroup; unclassified or missing -> UNAVAILABLE", () => {
  const rule = { blockRiskGroups: ["g-block"], passRiskGroups: ["g-pass"] };
  assert.equal(interpretSignature({ riskGroup: "g-pass" }, rule).verdict, "SAFE");
  assert.equal(interpretSignature({ riskGroup: "g-block" }, rule).verdict, "RISKY");
  assert.equal(interpretSignature({ riskGroup: "something-new" }, rule).verdict, "UNAVAILABLE");
  assert.equal(interpretSignature({}, rule).verdict, "UNAVAILABLE");
});

test("scan message: with the shipped config every riskGroup is still unclassified (BLOCK)", () => {
  assert.equal(interpretSignature({ riskGroup: "anything" }, rules.message).verdict, "UNAVAILABLE");
});
