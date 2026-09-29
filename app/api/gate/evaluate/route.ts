import { NextResponse, type NextRequest } from "next/server";
import { evaluate, evaluateAction } from "@/lib/gate";
import { agentAuthorized, baseUrl, errorResponse, unauthorized } from "@/lib/http";

// Called by the agent before it acts.
//   { task_id, action_type: "pay", payload: { url, purpose } }  -> 402 flow: screen, decide, pay
//   { task_id, action_type: "commit" | "disclose" | "impersonate", payload } -> judged and recorded
//     only; the agent performs the action itself if allowed.
//   { url, purpose, run_id } (legacy, no task) -> the original Base flow.
export async function POST(req: NextRequest) {
  if (!agentAuthorized(req)) return unauthorized();
  const body = (await req.json()) as {
    task_id?: string;
    action_type?: string;
    payload?: Record<string, unknown>;
    url?: string;
    purpose?: string;
    run_id?: string;
  };
  try {
    const action = body.action_type ?? "pay";
    if (action !== "pay") {
      return NextResponse.json(await evaluateAction({ task_id: body.task_id, action_type: action, payload: body.payload, baseUrl: baseUrl(req) }));
    }
    const url = String(body.payload?.url ?? body.url ?? "");
    const purpose = String(body.payload?.purpose ?? body.purpose ?? "");
    if (!url) return errorResponse(new Error("payload.url is required for pay"));
    if (body.task_id === undefined && !body.run_id) return errorResponse(new Error("task_id (or legacy run_id) is required"));
    return NextResponse.json(await evaluate({ url, purpose, task_id: body.task_id, run_id: body.run_id, baseUrl: baseUrl(req) }));
  } catch (e) {
    return errorResponse(e, 502);
  }
}
