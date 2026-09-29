import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

const bearer = (req: NextRequest) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

function tokenMatches(want: string | undefined, got: string): boolean {
  if (!want) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Agent-facing endpoints require the shared agent token. */
export function agentAuthorized(req: NextRequest): boolean {
  return tokenMatches(process.env.AGENT_TOKEN, bearer(req));
}

/**
 * Owner-only endpoints (issuing and closing tasks). The agent's credential must never work
 * here: an agent that could open tasks could open a new budget whenever one ran out.
 * If OWNER_TOKEN is unset, or equal to AGENT_TOKEN, nobody is authorized.
 */
export function ownerAuthorized(req: NextRequest): boolean {
  const owner = process.env.OWNER_TOKEN;
  if (!owner || owner === process.env.AGENT_TOKEN) return false;
  return tokenMatches(owner, bearer(req));
}

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export const baseUrl = (req: NextRequest) => process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;

export function errorResponse(e: unknown, status = 400) {
  return NextResponse.json({ error: (e as Error).message }, { status });
}
