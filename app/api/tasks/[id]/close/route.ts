import { NextResponse, type NextRequest } from "next/server";
import { closeTask, TaskError } from "@/lib/tasks";
import { errorResponse, ownerAuthorized, unauthorized } from "@/lib/http";

// Owner only. Revokes the task's Allowance on chain. Irreversible.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/tasks/[id]/close">) {
  if (!ownerAuthorized(req)) return unauthorized();
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await closeTask(id));
  } catch (e) {
    return errorResponse(e, e instanceof TaskError ? e.status : 502);
  }
}
