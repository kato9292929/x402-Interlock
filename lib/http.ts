import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

/** Agent-facing endpoints require the shared agent token. */
export function agentAuthorized(req: NextRequest): boolean {
  const want = process.env.AGENT_TOKEN;
  const got = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!want) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export const baseUrl = (req: NextRequest) => process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;

export function errorResponse(e: unknown, status = 400) {
  return NextResponse.json({ error: (e as Error).message }, { status });
}
