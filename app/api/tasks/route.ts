import { NextResponse, type NextRequest } from "next/server";
import { listTasks, openTask, TaskError } from "@/lib/tasks";
import { errorResponse, ownerAuthorized, unauthorized } from "@/lib/http";

// Owner only. Opening a task creates one Solana Allowance delegated to the gate's key.
export async function POST(req: NextRequest) {
  if (!ownerAuthorized(req)) return unauthorized();
  try {
    const body = (await req.json()) as { purpose: string; budget: { amount: string; asset?: string }; expires_at: string };
    return NextResponse.json(await openTask(body), { status: 201 });
  } catch (e) {
    return errorResponse(e, e instanceof TaskError ? e.status : 502);
  }
}

export async function GET(req: NextRequest) {
  if (!ownerAuthorized(req)) return unauthorized();
  return NextResponse.json(listTasks());
}
