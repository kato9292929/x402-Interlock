import { NextResponse, type NextRequest } from "next/server";
import { view } from "@/lib/gate";
import { agentAuthorized, baseUrl, errorResponse, unauthorized } from "@/lib/http";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/gate/[id]">) {
  if (!agentAuthorized(req)) return unauthorized();
  const { id } = await ctx.params;
  try {
    return NextResponse.json(view(id, baseUrl(req)));
  } catch (e) {
    return errorResponse(e, 404);
  }
}
