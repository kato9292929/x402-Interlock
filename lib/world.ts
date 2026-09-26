import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";

// World ID human approval for ASK_HUMAN payments.
//
// Credential: proof_of_human (Orb). See README "Why proof_of_human" for the reasoning.
// The proof is bound to one payment through the signal, to one request through the
// RP nonce, and to the agent owner through the nullifier (same person + same action
// => same nullifier). Verification happens only here, on the server.

const DATA = () => process.env.DATA_DIR ?? path.join(process.cwd(), "data");

export const WORLD_ENV = () => (process.env.WORLD_ENVIRONMENT ?? "sandbox") as "production" | "staging" | "sandbox";
const VERIFY_BASE = () => process.env.WORLD_VERIFY_BASE_URL ?? "https://developer.world.org";
const TTL = () => Number(process.env.WORLD_APPROVAL_TTL_SECONDS ?? 180);

/**
 * Optional API key for verifying sandbox/staging proofs. The official docs checked on
 * 2026-09-26 (developer-docs openapi/developer-portal.json, world-id/sandbox/sandbox-access.mdx,
 * idkit-core 4.3.0, human-in-the-loop 0.2.1) define no auth for POST /api/v4/verify, so the
 * header name is not known. It is configured (WORLD_API_KEY_HEADER), never guessed, and the
 * key is never sent for production.
 */
export class WorldConfigError extends Error {}

export function verifyAuthHeaders(environment: string): Record<string, string> {
  if (environment === "production") return {};
  const key = process.env.WORLD_API_KEY;
  const header = process.env.WORLD_API_KEY_HEADER;
  if (!key && !header) return {};
  if (!key || !header) {
    throw new WorldConfigError(
      `World ID ${environment} verification is half-configured: set both WORLD_API_KEY and WORLD_API_KEY_HEADER, or neither`,
    );
  }
  return { [header]: key };
}

const unauthorizedHint = (environment: string) =>
  environment === "production"
    ? "World rejected the verify call as unauthenticated"
    : `World rejected the ${environment} verify call as unauthenticated: ${environment} verification likely needs a team API key. ` +
      (process.env.WORLD_API_KEY ? "The configured WORLD_API_KEY / WORLD_API_KEY_HEADER was refused." : "Set WORLD_API_KEY and WORLD_API_KEY_HEADER.");

export function worldAction(decisionId: string): string {
  // One stable action per agent so the owner's nullifier is stable and can be pinned.
  // Setting WORLD_ACTION_PER_DECISION=1 scopes the action to the decision instead
  // (then any unique human can approve; owner pinning is skipped).
  return process.env.WORLD_ACTION_PER_DECISION === "1"
    ? `interlock-${decisionId}`
    : process.env.WORLD_ACTION ?? "interlock-approve-payment";
}

/** The signal commits the proof to exactly this payment. */
export function paymentSignal(p: { decision_id: string; payTo: string; amount: string; asset: string; network: string }) {
  return [p.decision_id, p.network, p.asset.toLowerCase(), p.payTo.toLowerCase(), p.amount].join("|");
}

export interface ApprovalRequest {
  decision_id: string;
  app_id: string;
  action: string;
  signal: string;
  environment: string;
  require_user_presence: boolean;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
  summary: { payTo: string; amount: string; amount_display: string; asset: string; network: string; resource: string; purpose: string };
}

// RP contexts contain the RP signature, so they live outside the ledger.
const file = (id: string) => path.join(DATA(), "approvals", `${id}.json`);

export function createApprovalRequest(decision_id: string, summary: ApprovalRequest["summary"]): ApprovalRequest {
  const app_id = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  const rp_id = process.env.WORLD_RP_ID;
  const signingKeyHex = process.env.WORLD_SIGNING_KEY;
  if (!app_id || !rp_id || !signingKeyHex) throw new Error("NEXT_PUBLIC_WORLD_APP_ID / WORLD_RP_ID / WORLD_SIGNING_KEY not set");
  const action = worldAction(decision_id);
  // Fail before the owner is asked to scan anything if verification could never succeed.
  verifyAuthHeaders(WORLD_ENV());
  const sig = signRequest({ signingKeyHex, action, ttl: TTL() });
  const req: ApprovalRequest = {
    decision_id,
    app_id,
    action,
    signal: paymentSignal({ decision_id, ...summary }),
    environment: WORLD_ENV(),
    require_user_presence: process.env.WORLD_REQUIRE_USER_PRESENCE !== "0",
    rp_context: { rp_id, nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig },
    summary,
  };
  mkdirSync(path.dirname(file(decision_id)), { recursive: true });
  writeFileSync(file(decision_id), JSON.stringify(req, null, 2));
  return req;
}

export function loadApprovalRequest(decision_id: string): ApprovalRequest | null {
  if (!/^[0-9a-f-]{36}$/.test(decision_id) || !existsSync(file(decision_id))) return null;
  return JSON.parse(readFileSync(file(decision_id), "utf8")) as ApprovalRequest;
}

// ---- owner pinning (trust on first use, or pinned via env) ----
const ownerFile = () => path.join(DATA(), "owner.json");

function ownerNullifier(): string | null {
  if (process.env.WORLD_OWNER_NULLIFIER) return process.env.WORLD_OWNER_NULLIFIER;
  if (!existsSync(ownerFile())) return null;
  return (JSON.parse(readFileSync(ownerFile(), "utf8")) as { nullifier: string }).nullifier;
}

const normNullifier = (n: string) => BigInt(n).toString(16);

export interface VerificationOutcome {
  ok: boolean;
  reason: string;
  nullifier?: string;
  credential?: string;
  world_response?: unknown;
}

/**
 * Server-side verification. The browser only relays the IDKit result; nothing it
 * says is trusted until the World Developer API and the local checks agree.
 */
export async function verifyApproval(req: ApprovalRequest, result: IDKitResult, now = Date.now()): Promise<VerificationOutcome> {
  if (now / 1000 > req.rp_context.expires_at) return { ok: false, reason: "request_expired" };

  const r = result as unknown as Record<string, unknown>;
  if (r.protocol_version !== "4.0") return { ok: false, reason: "unsupported_protocol_version" };
  if (r.nonce !== req.rp_context.nonce) return { ok: false, reason: "nonce_mismatch" };
  if (r.action !== req.action) return { ok: false, reason: "action_mismatch" };
  if (r.environment !== req.environment) return { ok: false, reason: "environment_mismatch" };

  const responses = (Array.isArray(r.responses) ? r.responses : []) as { identifier: string; signal_hash?: string; nullifier: string }[];
  const item = responses.find((x) => x.identifier === "proof_of_human");
  if (!item) return { ok: false, reason: "credential_not_proof_of_human" };
  const expectedSignalHash = hashSignal(req.signal);
  if (!item.signal_hash || BigInt(item.signal_hash) !== BigInt(expectedSignalHash)) {
    return { ok: false, reason: "signal_mismatch" };
  }

  let auth: Record<string, string>;
  try {
    auth = verifyAuthHeaders(req.environment);
  } catch (e) {
    return { ok: false, reason: `world_config_error: ${(e as Error).message}` };
  }
  let world: { status: number; body: unknown };
  try {
    const res = await fetch(`${VERIFY_BASE()}/api/v4/verify/${req.rp_context.rp_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ ...result, environment: req.environment }),
      signal: AbortSignal.timeout(15_000),
    });
    world = { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, reason: `world_verify_unreachable: ${(e as Error).message}` };
  }
  const body = (world.body ?? {}) as { success?: boolean; action?: string; environment?: string; code?: string };
  // Only World's own JSON 401/403 points at credentials; a non-JSON 403 (e.g. a proxy) does not.
  if ((world.status === 401 || world.status === 403) && world.body !== null) {
    return { ok: false, reason: `world_verify_unauthorized (HTTP ${world.status}): ${unauthorizedHint(req.environment)}`, world_response: world.body };
  }
  if (world.status !== 200 || body.success !== true) {
    return { ok: false, reason: `world_verify_failed: ${body.code ?? world.status}`, world_response: world.body };
  }
  if (body.action && body.action !== req.action) return { ok: false, reason: "world_action_mismatch", world_response: world.body };
  if (body.environment && body.environment !== req.environment) {
    return { ok: false, reason: "world_environment_mismatch", world_response: world.body };
  }

  // Owner pinning only makes sense with a stable action.
  if (process.env.WORLD_ACTION_PER_DECISION !== "1") {
    const owner = ownerNullifier();
    if (!owner) {
      mkdirSync(path.dirname(ownerFile()), { recursive: true });
      writeFileSync(ownerFile(), JSON.stringify({ nullifier: item.nullifier, pinned_at: new Date().toISOString() }));
    } else if (normNullifier(owner) !== normNullifier(item.nullifier)) {
      return { ok: false, reason: "not_agent_owner", nullifier: item.nullifier, world_response: world.body };
    }
  }

  return { ok: true, reason: "verified", nullifier: item.nullifier, credential: item.identifier, world_response: world.body };
}
