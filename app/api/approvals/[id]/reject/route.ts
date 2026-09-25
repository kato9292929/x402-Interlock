import { NextResponse, type NextRequest } from "next/server";
import { reject } from "@/lib/gate";
import { errorResponse } from "@/lib/http";

// Rejecting only ever prevents a payment, so it does not need a proof.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/approvals/[id]/reject">) {
  const { id } = await ctx.params;
  const { reason } = (await req.json().catch(() => ({}))) as { reason?: string };
  try {
    return NextResponse.json(reject(id, reason ?? "rejected_by_owner"));
  } catch (e) {
    return errorResponse(e, 404);
  }
}
