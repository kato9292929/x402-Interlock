import { NextResponse, type NextRequest } from "next/server";
import { cancel } from "@/lib/gate";
import { errorResponse } from "@/lib/http";

// Cancel (by the agent giving up, or the owner closing the dialog). Never pays.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/approvals/[id]/cancel">) {
  const { id } = await ctx.params;
  const { reason } = (await req.json().catch(() => ({}))) as { reason?: string };
  try {
    return NextResponse.json(cancel(id, reason ?? "cancelled"));
  } catch (e) {
    return errorResponse(e, 404);
  }
}
