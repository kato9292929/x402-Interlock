import { createHash } from "node:crypto";
import { TypeSafeClient, type Question, type Questions } from "@typesafe-ai/sdk";

// Jev (TypeSafe's System One model), or another server with the same /v1/systemone contract
// (spec/07 provider switch: Clef, self-hosted), answers bounded questions about a state: a yes/no
// probability (noul), a choice among labels, or a score on a rubric. Interlock uses it for
// meaning only (spec/07, principle 1): budgets, payees, limits and signatures stay in code.
//
// Contract, from the official SDK @typesafe-ai/sdk 0.6.0 (the brief's /v1/decisions and
// "binary" are named /v1/systemone and "noul" there):
//   POST {TYPESAFE_BASE_URL or https://api.typesafe.ai}/v1/systemone, Authorization: Bearer key
//   { model, state, questions: { name: { type, instructions, criteria } } }
//   -> { model, answers: { name: { type, noul | choice+confidence+probabilities |
//        score+confidence+legend+probabilities } }, usage: { input_tokens, output_tokens } }
//
// Every failure (no key, HTTP error, timeout, an answer that does not match its question) is
// UNAVAILABLE. Callers treat UNAVAILABLE as ASK_HUMAN (fail closed); nothing here decides.

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export type JevResult =
  | {
      status: "OK";
      /** which configured provider answered (config/appe-thresholds.json providers) */
      provider?: string;
      /** The model string the API returned: always recorded, for reproducibility. */
      model: string;
      answers: Record<string, JevAnswer>;
      usage?: { input_tokens: number; output_tokens: number };
      latency_ms: number;
      cached?: boolean;
    }
  | { status: "UNAVAILABLE"; reason: string; latency_ms: number; model?: undefined };

export interface JevOptions {
  /** Name of the provider, recorded with every answer. Default "typesafe". */
  provider?: string;
  /** Server base URL. Unset: TYPESAFE_BASE_URL or https://api.typesafe.ai (typesafe only). */
  baseURL?: string;
  /**
   * The bearer key. undefined: TYPESAFE_API_KEY (typesafe only). null: the server needs none.
   * Any provider other than the default always passes a value here, so the TypeSafe key can
   * never be sent to another server by the SDK's own environment fallback.
   */
  apiKey?: string | null;
  /** Set when the provider is not usable (e.g. its URL is not configured): UNAVAILABLE with this reason. */
  unavailable?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  /** The model string the answer must come from; any other is UNAVAILABLE (reproducibility). */
  expectedModel?: string;
  /** Reuse an identical (model, state, questions) answer for this long. 0 = off. */
  cacheMs?: number;
}

const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Check one answer against the question that was asked. Anything off -> a reason string. */
export function checkAnswer(q: Question, a: unknown): string | undefined {
  const x = a as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return "missing answer";
  if (x.type !== q.type) return `type ${String(x.type)} for a ${q.type} question`;
  if (q.type === "noul") return isProb(x.noul) ? undefined : "noul is not a probability";
  const probs = x.probabilities as Record<string, unknown> | undefined;
  if (!probs || typeof probs !== "object" || !Object.values(probs).every(isProb)) return "probabilities missing or invalid";
  if (!isProb(x.confidence)) return "confidence is not a probability";
  if (q.type === "choice") {
    const labels = Object.keys(q.criteria);
    if (typeof x.choice !== "string" || !labels.includes(x.choice)) return `choice ${String(x.choice)} is not one of the labels`;
    if (Object.keys(probs).some((k) => !labels.includes(k))) return "probabilities name an unknown label";
    return undefined;
  }
  const max = q.criteria.length - 1;
  if (typeof x.score !== "number" || x.score < 0 || x.score > max) return `score ${String(x.score)} outside 0..${max}`;
  return undefined;
}

const g = globalThis as { __interlockJevCache?: Map<string, { at: number; result: JevResult & { status: "OK" } }> };
const cache = (g.__interlockJevCache ??= new Map());
export const clearJevCache = () => cache.clear();

/**
 * Ask Jev. `state` is data only: seller text, purchased content and agent claims go in as JSON
 * values, never into the question text, so they are evaluated rather than followed.
 */
/**
 * Limits the API enforces that the SDK's types do not (found live 2026-10-04): at most 10 score
 * levels, and every criterion described by a non-null value. Checked before sending, so a bad
 * question is a clear UNAVAILABLE reason instead of an HTTP 400/422.
 */
export function questionProblem(questions: Questions): string | undefined {
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "score") {
      if (q.criteria.length > 10) return `question ${name}: ${q.criteria.length} score levels, the API allows at most 10`;
      if (q.criteria.some((c) => c === null)) return `question ${name}: a score level without a description`;
    }
    if (q.type === "choice" && Object.values(q.criteria).some((c) => c === null)) return `question ${name}: a choice label without a description`;
  }
  return undefined;
}

export async function callJev(state: Record<string, unknown>, questions: Questions, opts: JevOptions = {}): Promise<JevResult> {
  const started = Date.now();
  const unavailable = (reason: string): JevResult => ({ status: "UNAVAILABLE", reason, latency_ms: Date.now() - started });
  if (opts.unavailable) return unavailable(opts.unavailable);
  const provider = opts.provider ?? "typesafe";
  if (opts.apiKey === undefined && provider !== "typesafe") return unavailable(`no API key setting for provider ${provider}`);
  const apiKey = opts.apiKey === undefined ? process.env.TYPESAFE_API_KEY : opts.apiKey;
  if (apiKey !== null && !apiKey) return unavailable(opts.apiKey === undefined ? "TYPESAFE_API_KEY is not set" : `empty API key for provider ${provider}`);
  const baseURL = opts.baseURL ?? (provider === "typesafe" ? process.env.TYPESAFE_BASE_URL || undefined : undefined);
  if (!baseURL && provider !== "typesafe") return unavailable(`no base URL for provider ${provider}`);
  const bad = questionProblem(questions);
  if (bad) return unavailable(bad);
  const model = opts.model ?? "jev-latest";
  const key = createHash("sha256").update(JSON.stringify([provider, baseURL ?? "", model, state, questions])).digest("hex");
  const cacheMs = opts.cacheMs ?? 0;
  const hit = cache.get(key);
  if (cacheMs > 0 && hit && Date.now() - hit.at < cacheMs) return { ...hit.result, cached: true, latency_ms: Date.now() - started };

  let body: unknown;
  try {
    const client = new TypeSafeClient({
      // A server that needs no key still gets a placeholder: the SDK would otherwise read
      // TYPESAFE_API_KEY from the environment and send it there.
      apiKey: apiKey ?? "unused",
      baseURL,
      defaultModel: model,
      logLevel: "off",
      timeout: opts.timeoutMs ?? 3000,
      // One retry, short backoff, and never a long server-requested wait: the gate is waiting.
      retry: { maxRetries: opts.retries ?? 1, backoffInitialMs: 200, backoffMaxMs: 500, respectRetryAfter: false },
    });
    body = await client.systemOne({ state: state as never, questions, model });
  } catch (e) {
    const err = e as { status?: number; name?: string; message?: string; body?: unknown };
    // Keep the API's own explanation (e.g. which field a 422 rejected); it holds no secrets.
    const detail = err.body === undefined ? "" : `: ${(typeof err.body === "string" ? err.body : JSON.stringify(err.body)).slice(0, 500)}`;
    return unavailable(err.status ? `HTTP ${err.status}${detail}` : `${err.name ?? "Error"}: ${err.message ?? String(e)}`);
  }

  const b = body as { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } } | null;
  if (!b || typeof b.model !== "string" || !b.model || !b.answers || typeof b.answers !== "object") return unavailable("response does not match the systemone schema");
  if (opts.expectedModel && b.model !== opts.expectedModel) return unavailable(`answered by ${b.model}, expected ${opts.expectedModel}`);
  const answers: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const problem = checkAnswer(q, b.answers[name]);
    if (problem) return unavailable(`answer ${name}: ${problem}`);
    answers[name] = b.answers[name] as JevAnswer;
  }
  const result = { status: "OK" as const, provider, model: b.model, answers, usage: b.usage, latency_ms: Date.now() - started };
  if (cacheMs > 0) cache.set(key, { at: Date.now(), result });
  return result;
}
