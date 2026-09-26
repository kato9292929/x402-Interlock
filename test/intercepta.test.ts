import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { clearTokenCache, interpretAddress, interpretSignature, interpretToken, quickScanAddress, scanToken } from "../lib/intercepta";
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

// ---- token cache and rate limits, against a local HTTP stand-in (test only) ----

async function withApi(handler: (url: string) => [number, unknown], fn: (hits: string[]) => Promise<void>) {
  const hits: string[] = [];
  const srv = createServer((q, s) => {
    hits.push(q.url!);
    const [status, body] = handler(q.url!);
    s.writeHead(status, { "content-type": "application/json" });
    s.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  process.env.INTERCEPTA_BASE_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.INTERCEPTA_API_KEY = "test-key";
  clearTokenCache();
  try {
    await fn(hits);
  } finally {
    srv.close();
    clearTokenCache();
  }
}

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const info = { riskScore: 0, riskLevel: "neutral", category: "info", trust: "whitelist", action: "info", detectors: [] };
const TEN_MIN = 10 * 60_000;

test("token cache: second scan within TTL is served from cache, not the API", async () => {
  await withApi(() => [200, info], async (hits) => {
    const t0 = 1_000_000;
    const a = await scanToken(USDC, "8453", rules.token, 1000, TEN_MIN, t0);
    const b = await scanToken(USDC.toLowerCase(), "8453", rules.token, 1000, TEN_MIN, t0 + 60_000);
    assert.equal(hits.length, 1);
    assert.equal(a.cache, undefined);
    assert.equal(b.verdict, "SAFE");
    assert.equal(b.cache?.hit, true);
    assert.equal(b.cache?.fetched_at, new Date(t0).toISOString());
  });
});

test("token cache: expires after TTL; keyed by chainId + token", async () => {
  await withApi(() => [200, info], async (hits) => {
    const t0 = 1_000_000;
    await scanToken(USDC, "8453", rules.token, 1000, TEN_MIN, t0);
    await scanToken(USDC, "8453", rules.token, 1000, TEN_MIN, t0 + TEN_MIN + 1);
    await scanToken(USDC, "1", rules.token, 1000, TEN_MIN, t0 + TEN_MIN + 2);
    await scanToken("0x0000000000000000000000000000000000000001", "8453", rules.token, 1000, TEN_MIN, t0 + TEN_MIN + 3);
    assert.equal(hits.length, 4);
  });
});

test("token cache: 0 minutes disables it", async () => {
  await withApi(() => [200, info], async (hits) => {
    await scanToken(USDC, "8453", rules.token, 1000, 0);
    await scanToken(USDC, "8453", rules.token, 1000, 0);
    assert.equal(hits.length, 2);
  });
});

test("429: UNAVAILABLE with an explicit rate-limit reason, and never cached", async () => {
  let limited = true;
  await withApi(() => (limited ? [429, { message: "API Key rate limit is reached" }] : [200, info]), async (hits) => {
    const r = await scanToken(USDC, "8453", rules.token, 1000, TEN_MIN, 1_000_000);
    assert.equal(r.verdict, "UNAVAILABLE");
    assert.deepEqual(r.reasons, ["rate limit reached (HTTP 429): API Key rate limit is reached"]);
    limited = false;
    const again = await scanToken(USDC, "8453", rules.token, 1000, TEN_MIN, 1_000_001);
    assert.equal(again.verdict, "SAFE");
    assert.equal(again.cache, undefined);
    assert.equal(hits.length, 2);
  });
});

test("address scans are never cached", async () => {
  await withApi(() => [200, { toxicScore: 0, traits: [] }], async (hits) => {
    await quickScanAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rules.address, 1000);
    await quickScanAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rules.address, 1000);
    assert.equal(hits.length, 2);
  });
});
