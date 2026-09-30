import { NextResponse, type NextRequest } from "next/server";
import { listTasks, openTask, TaskError } from "@/lib/tasks";
import { errorResponse, ownerAuthorized, unauthorized } from "@/lib/http";
import { SolanaSetupError } from "@/lib/solana/allowance";
import { explainSolanaError } from "@/lib/solana/errors";

// Owner only. Opening a task creates one Solana Allowance delegated to the gate's key.
export async function POST(req: NextRequest) {
  if (!ownerAuthorized(req)) return unauthorized();
  try {
    const body = (await req.json()) as { purpose: string; budget: { amount: string; asset?: string }; expires_at: string };
    return NextResponse.json(await openTask(body), { status: 201 });
  } catch (e) {
    if (e instanceof TaskError) return errorResponse(e, e.status);
    if (e instanceof SolanaSetupError) return errorResponse(e, 409);
    // Chain failure: return causes and simulation logs to the owner (no secrets are in them).
    console.error(e);
    return NextResponse.json({ error: (e as Error).message, details: explainSolanaError(e) }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  if (!ownerAuthorized(req)) return unauthorized();
  return NextResponse.json(listTasks());
}
