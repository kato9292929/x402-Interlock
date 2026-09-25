import { NextResponse, type NextRequest } from "next/server";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { approve } from "@/lib/gate";
import { errorResponse } from "@/lib/http";

// The browser relays the IDKit result. Nothing is approved until lib/world.ts
// has verified it with the World Developer API and matched nonce, action, signal and owner.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/approvals/[id]/verify">) {
  const { id } = await ctx.params;
  try {
    const { result } = (await req.json()) as { result: IDKitResult };
    const { outcome, view } = await approve(id, result);
    return NextResponse.json({ verified: outcome.ok, reason: outcome.reason, view }, { status: outcome.ok ? 200 : 403 });
  } catch (e) {
    return errorResponse(e);
  }
}
