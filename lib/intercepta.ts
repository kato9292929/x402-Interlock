// Intercepta (Web3 Antivirus API) client. Official reference: https://docs.web3antivirus.io/reference/
//   Scan Message       https://docs.web3antivirus.io/reference/  (analysis/signature; spec given by the owner, see spec/03)
//   Quick Scan Address https://docs.web3antivirus.io/reference/quick-scan-address   -- NOT yet checked against the page
//   Deep Scan Address  https://docs.web3antivirus.io/reference/scan-address         -- NOT yet checked against the page
//   Scan Token         https://docs.web3antivirus.io/reference/scan-token           -- NOT yet checked against the page
// All screening is against Base mainnet (chainId 8453): the risk data is mainnet-only.
// Every call goes to the real API. There is no mock or fallback value: if the API
// does not answer with a recognisable body, the check is UNAVAILABLE and the gate BLOCKs.

const BASE = () => process.env.INTERCEPTA_BASE_URL ?? "https://api.web3antivirus.io";

export type CheckVerdict = "SAFE" | "RISKY" | "UNAVAILABLE";

export interface CheckResult {
  check: "quick_scan_address" | "deep_scan_address" | "scan_token" | "scan_message";
  target: string;
  verdict: CheckVerdict;
  reasons: string[];
  http_status?: number;
  response?: unknown; // raw API body, stored in the ledger as evidence
  error?: string;
}

async function call(
  method: "GET" | "POST",
  pathAndQuery: string,
  timeoutMs: number,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const key = process.env.INTERCEPTA_API_KEY;
  if (!key) throw new Error("INTERCEPTA_API_KEY is not set");
  const res = await fetch(BASE() + pathAndQuery, {
    method,
    headers: { "X-API-KEY": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, json };
}

interface Trait {
  name?: string;
  risk?: string;
  description?: string;
}

export interface AddressRule {
  blockAtScore: number;
  blockOnAnyTrait: boolean;
}

/** Interpret a Quick/Deep Scan Address body: `{ toxicScore, traits: [{ name, risk, description }] }`. */
export function interpretAddress(json: unknown, rule: AddressRule): { verdict: CheckVerdict; reasons: string[] } {
  const o = (json ?? {}) as Record<string, unknown>;
  const score = (o.toxicScore ?? o.toxic_score) as unknown;
  const traits = (Array.isArray(o.traits) ? o.traits : []) as Trait[];
  if (typeof score !== "number") return { verdict: "UNAVAILABLE", reasons: ["unrecognised address scan response"] };
  const reasons = traits.map((t) => `${t.name ?? "trait"}${t.risk ? ` (${t.risk})` : ""}${t.description ? `: ${t.description}` : ""}`);
  const risky = score >= rule.blockAtScore || (rule.blockOnAnyTrait && traits.length > 0);
  return { verdict: risky ? "RISKY" : "SAFE", reasons: [`toxicScore=${score}`, ...reasons] };
}

/** Interpret Scan Token / Scan Message bodies: `{ action, riskLevel, detectors: [{ code, description }] }`. */
export function interpretFindings(json: unknown): { verdict: CheckVerdict; reasons: string[] } {
  const o = (json ?? {}) as Record<string, unknown>;
  const findings = (Array.isArray(o.detectors) ? o.detectors : Array.isArray(o.risks) ? o.risks : undefined) as
    | { code?: string; name?: string; description?: string; severity?: string }[]
    | undefined;
  const action = typeof o.action === "string" ? o.action.toLowerCase() : undefined;
  const level = typeof o.riskLevel === "string" ? o.riskLevel.toLowerCase() : undefined;
  if (!findings && !action && !level) return { verdict: "UNAVAILABLE", reasons: ["unrecognised scan response"] };
  const reasons = [
    ...(action ? [`action=${action}`] : []),
    ...(level ? [`riskLevel=${level}`] : []),
    ...(findings ?? []).map((f) => `${f.code ?? f.name ?? "finding"}${f.description ? `: ${f.description}` : ""}`),
  ];
  const risky =
    action === "block" || action === "warn" || level === "high" || level === "critical" || (!action && !level && !!findings?.length);
  return { verdict: risky ? "RISKY" : "SAFE", reasons };
}

async function run(
  check: CheckResult["check"],
  target: string,
  req: () => Promise<{ status: number; json: unknown }>,
  interpret: (json: unknown) => { verdict: CheckVerdict; reasons: string[] },
): Promise<CheckResult> {
  try {
    const { status, json } = await req();
    if (status < 200 || status >= 300) {
      return { check, target, verdict: "UNAVAILABLE", reasons: [`HTTP ${status}`], http_status: status, response: json };
    }
    return { check, target, ...interpret(json), http_status: status, response: json };
  } catch (e) {
    return { check, target, verdict: "UNAVAILABLE", reasons: ["no response"], error: (e as Error).message };
  }
}

export function quickScanAddress(address: string, rule: AddressRule, timeoutMs: number) {
  return run(
    "quick_scan_address",
    address,
    () => call("GET", `/api/public/v2/extension/account/${address}/quick-scan`, timeoutMs),
    (j) => interpretAddress(j, rule),
  );
}

export function deepScanAddress(address: string, rule: AddressRule, timeoutMs: number) {
  return run(
    "deep_scan_address",
    address,
    () => call("GET", `/api/public/v2/extension/account/${address}/toxic-score`, timeoutMs),
    (j) => interpretAddress(j, rule),
  );
}

export function scanToken(token: string, chainId: number, timeoutMs: number) {
  return run(
    "scan_token",
    `${chainId}:${token}`,
    () => call("GET", `/api/public/v2/extension/token-intelligence/token/${token}/risks?chainId=${chainId}`, timeoutMs),
    interpretFindings,
  );
}

export interface MessageRule {
  /** riskGroup values that BLOCK. From https://docs.web3antivirus.io/reference/scam-and-risk-library */
  blockRiskGroups: string[];
  /** riskGroup values that pass. Any value in neither list is UNAVAILABLE (fail closed). */
  passRiskGroups: string[];
}

/** Interpret a Scan Message body. The verdict comes from `riskGroup`; the rest is kept as evidence. */
export function interpretSignature(json: unknown, rule: MessageRule): { verdict: CheckVerdict; reasons: string[] } {
  const o = (json ?? {}) as Record<string, unknown>;
  const group = o.riskGroup;
  if (typeof group !== "string") return { verdict: "UNAVAILABLE", reasons: ["no riskGroup in scan message response"] };
  const reasons = [`riskGroup=${group}`];
  if (rule.blockRiskGroups.includes(group)) return { verdict: "RISKY", reasons };
  if (rule.passRiskGroups.includes(group)) return { verdict: "SAFE", reasons };
  return { verdict: "UNAVAILABLE", reasons: [...reasons, "riskGroup not classified in config/screening.json"] };
}

/**
 * Screen the EIP-712 message the signer is about to sign, before it is signed.
 * Body per the Scan Message reference: `message` is the EIP-712 payload itself
 * (domain, types, primaryType, message) and `chainId` is a string enum ("8453" = Base).
 */
export function scanMessage(from: string, typedData: unknown, chainId: string, website: string, rule: MessageRule, timeoutMs: number) {
  return run(
    "scan_message",
    from,
    () =>
      call("POST", `/api/public/v2/extension/analysis/signature`, timeoutMs, {
        from,
        message: typedData,
        website,
        chainId,
      }),
    (j) => interpretSignature(j, rule),
  );
}
