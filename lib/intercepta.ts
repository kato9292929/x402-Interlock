// Intercepta (Web3 Antivirus API) client. Official reference: https://docs.web3antivirus.io/reference/
//   Scan Message       https://docs.web3antivirus.io/reference/  (analysis/signature; spec given by the owner, see spec/03)
//   Quick Scan Address https://docs.web3antivirus.io/reference/quick-scan-address   (ToxicScoreShortResponseV2)
//   Deep Scan Address  https://docs.web3antivirus.io/reference/scan-address         (ToxicScoreShortResponseV2)
//   Scan Token         https://docs.web3antivirus.io/reference/scan-token           (TokenRiskAnalysisV2Response)
// Reference contents as pasted by the owner: spec/04-intercepta-official-spec.md
// All screening is against Base mainnet (chainId 8453): the risk data is mainnet-only.
// Every call goes to the real API. There is no mock or fallback value: if the API
// does not answer with a recognisable body, the check is UNAVAILABLE and the gate BLOCKs.

const BASE = () => process.env.INTERCEPTA_BASE_URL ?? "https://api.web3antivirus.io";

/** CAUTION = suspicious but not conclusive: the owner must approve (ASK_HUMAN). */
export type CheckVerdict = "SAFE" | "CAUTION" | "RISKY" | "UNAVAILABLE";

export interface CheckResult {
  check: "quick_scan_address" | "deep_scan_address" | "scan_token" | "scan_message";
  target: string;
  verdict: CheckVerdict;
  reasons: string[];
  http_status?: number;
  response?: unknown; // raw API body, stored in the ledger as evidence
  /** Set when the answer was served from the token cache instead of a new API call. */
  cache?: { hit: true; fetched_at: string };
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

// ToxicScoreShortResponseV2 (Quick Scan and Deep Scan share it)
interface Trait {
  name?: string;
  risk?: number;
  txsCount?: number;
  description?: string;
}

export interface AddressRule {
  /** trait names that BLOCK (asset theft / sanctions). */
  blockTraits: string[];
  /** trait names that need the owner (suspicious, not conclusive). */
  askHumanTraits: string[];
}

/**
 * Interpret a ToxicScoreShortResponseV2 body. The verdict comes from `traits[].name` only.
 * `toxicScore` has no published threshold, so it is reported but never decides on its own.
 * A trait name outside both lists is UNAVAILABLE (fail closed).
 */
export function interpretAddress(json: unknown, rule: AddressRule): { verdict: CheckVerdict; reasons: string[] } {
  const o = (json ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.traits)) return { verdict: "UNAVAILABLE", reasons: ["no traits[] in address scan response"] };
  const traits = o.traits as Trait[];
  const score = typeof o.toxicScore === "number" ? `toxicScore=${o.toxicScore} (informational)` : "toxicScore=n/a";
  const describe = (t: Trait) =>
    `${t.name ?? "trait"}${t.risk !== undefined ? ` (risk ${t.risk})` : ""}${t.description ? `: ${t.description}` : ""}`;
  const names = traits.map((t) => t.name ?? "");
  const unknown = names.filter((n) => !rule.blockTraits.includes(n) && !rule.askHumanTraits.includes(n));
  const reasons = [score, ...traits.map(describe)];
  if (names.some((n) => rule.blockTraits.includes(n))) return { verdict: "RISKY", reasons };
  if (unknown.length) return { verdict: "UNAVAILABLE", reasons: [...reasons, `unclassified trait: ${unknown.join(", ")}`] };
  if (names.length) return { verdict: "CAUTION", reasons };
  return { verdict: "SAFE", reasons };
}

export interface TokenRule {
  blockActions: string[];
  askHumanActions: string[];
  passActions: string[];
}

/**
 * Interpret a TokenRiskAnalysisV2Response body. The verdict follows the vendor's own
 * recommended `action` (block | warn | info); the other fields are reported as evidence.
 */
export function interpretToken(json: unknown, rule: TokenRule): { verdict: CheckVerdict; reasons: string[] } {
  const o = (json ?? {}) as Record<string, unknown>;
  const action = typeof o.action === "string" ? o.action : undefined;
  if (!action) return { verdict: "UNAVAILABLE", reasons: ["no action in token scan response"] };
  const detectors = (Array.isArray(o.detectors) ? o.detectors : []) as { code?: string; description?: string }[];
  const reasons = [
    `action=${action}`,
    ...(["riskLevel", "category", "trust", "riskScore"] as const).filter((k) => o[k] !== undefined).map((k) => `${k}=${o[k]}`),
    ...detectors.map((d) => `${d.code ?? "detector"}${d.description ? `: ${d.description}` : ""}`),
  ];
  if (rule.blockActions.includes(action)) return { verdict: "RISKY", reasons };
  if (rule.askHumanActions.includes(action)) return { verdict: "CAUTION", reasons };
  if (rule.passActions.includes(action)) return { verdict: "SAFE", reasons };
  return { verdict: "UNAVAILABLE", reasons: [...reasons, "action not classified in config/screening.json"] };
}

async function run(
  check: CheckResult["check"],
  target: string,
  req: () => Promise<{ status: number; json: unknown }>,
  interpret: (json: unknown) => { verdict: CheckVerdict; reasons: string[] },
): Promise<CheckResult> {
  try {
    const { status, json } = await req();
    if (status === 429) {
      // Rate limited: this check cannot answer, which says nothing about the payment itself.
      const msg = (json as { message?: unknown } | null)?.message;
      const detail = typeof msg === "string" ? msg : typeof json === "string" && json ? json : "";
      return {
        check,
        target,
        verdict: "UNAVAILABLE",
        reasons: [`rate limit reached (HTTP 429)${detail ? `: ${detail}` : ""}`],
        http_status: status,
        response: json,
      };
    }
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

// Token risk barely changes minute to minute, and the demo screens the same token (Base USDC)
// on every payment, so answered token scans are cached per (chainId, token) for a short time.
// Only 2xx answers the gate could interpret are cached; failures (429, timeouts, unknown bodies)
// are retried on the next payment. Address scans and Scan Message are never cached.
// Kept on globalThis so every Next.js route bundle shares one cache.
type TokenCacheEntry = { at: number; status: number; json: unknown };
const g = globalThis as { __interlockTokenCache?: Map<string, TokenCacheEntry> };
const tokenCache = (g.__interlockTokenCache ??= new Map());

export function clearTokenCache() {
  tokenCache.clear();
}

export async function scanToken(
  token: string,
  chainId: string,
  rule: TokenRule,
  timeoutMs: number,
  cacheMs = 0,
  now = Date.now(),
): Promise<CheckResult> {
  const target = `${chainId}:${token}`;
  const key = `${chainId}:${token.toLowerCase()}`;
  const hit = cacheMs > 0 ? tokenCache.get(key) : undefined;
  if (hit && now - hit.at < cacheMs) {
    const r = await run("scan_token", target, async () => ({ status: hit.status, json: hit.json }), (j) => interpretToken(j, rule));
    return { ...r, cache: { hit: true, fetched_at: new Date(hit.at).toISOString() } };
  }
  let fresh: { status: number; json: unknown } | undefined;
  const r = await run(
    "scan_token",
    target,
    async () =>
      (fresh = await call("GET", `/api/public/v2/extension/token-intelligence/token/${token}/risks?chainId=${chainId}`, timeoutMs)),
    (j) => interpretToken(j, rule),
  );
  if (cacheMs > 0 && fresh && r.verdict !== "UNAVAILABLE") tokenCache.set(key, { at: now, ...fresh });
  return r;
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
