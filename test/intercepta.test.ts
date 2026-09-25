import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretAddress, interpretFindings } from "../lib/intercepta";

// These test the parsing rules only. The API itself is never mocked at runtime.
const rule = { blockAtScore: 1, blockOnAnyTrait: true };

test("clean address -> SAFE", () => {
  assert.equal(interpretAddress({ toxicScore: 0, traits: [] }, rule).verdict, "SAFE");
});

test("toxic score or traits -> RISKY, with trait reasons", () => {
  const r = interpretAddress({ toxicScore: 90, traits: [{ name: "sanction_address", risk: "high", description: "OFAC" }] }, rule);
  assert.equal(r.verdict, "RISKY");
  assert.ok(r.reasons.some((x) => x.includes("sanction_address")));
  assert.equal(interpretAddress({ toxicScore: 0, traits: [{ name: "mixer_transfers" }] }, rule).verdict, "RISKY");
});

test("snake_case score accepted", () => {
  assert.equal(interpretAddress({ toxic_score: 0 }, rule).verdict, "SAFE");
});

test("unrecognised body -> UNAVAILABLE (fail closed)", () => {
  assert.equal(interpretAddress({ hello: 1 }, rule).verdict, "UNAVAILABLE");
  assert.equal(interpretAddress("<html>", rule).verdict, "UNAVAILABLE");
  assert.equal(interpretFindings({}).verdict, "UNAVAILABLE");
});

test("token/message findings", () => {
  assert.equal(interpretFindings({ action: "info", detectors: [] }).verdict, "SAFE");
  assert.equal(interpretFindings({ action: "block", detectors: [{ code: "FAKE_TOKEN" }] }).verdict, "RISKY");
  assert.equal(interpretFindings({ riskLevel: "high" }).verdict, "RISKY");
  assert.equal(interpretFindings({ detectors: [] }).verdict, "SAFE");
  assert.equal(interpretFindings({ risks: [{ name: "x" }] }).verdict, "RISKY");
});
