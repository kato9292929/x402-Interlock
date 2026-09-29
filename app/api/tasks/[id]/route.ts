import { NextResponse, type NextRequest } from "next/server";
import { getTask, taskUsage } from "@/lib/tasks";
import { agentAuthorized, errorResponse, ownerAuthorized, unauthorized } from "@/lib/http";

// Readable by the owner and by the agent (so it can see its remaining budget).
export async function GET(req: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) {
  if (!ownerAuthorized(req) && !agentAuthorized(req)) return unauthorized();
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return errorResponse(new Error("unknown task"), 404);
  return NextResponse.json({ ...task, usage: await taskUsage(task) });
}
