import { NextResponse, type NextRequest } from "next/server";
import { evaluate } from "@/lib/gate";
import { agentAuthorized, baseUrl, errorResponse, unauthorized } from "@/lib/http";

// Called by the agent after it receives a 402. The gate re-fetches the 402 itself,
// screens, decides, and (for PAY / CAP) signs and pays on the agent's behalf.
export async function POST(req: NextRequest) {
  if (!agentAuthorized(req)) return unauthorized();
  const { url, purpose, run_id } = (await req.json()) as { url?: string; purpose?: string; run_id?: string };
  if (!url || !run_id) return errorResponse(new Error("url and run_id are required"));
  try {
    return NextResponse.json(await evaluate({ url, purpose: purpose ?? "", run_id, baseUrl: baseUrl(req) }));
  } catch (e) {
    return errorResponse(e, 502);
  }
}
