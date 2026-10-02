import { NextResponse, type NextRequest } from "next/server";
import { sendMessage } from "@/lib/gate";
import { agentAuthorized, baseUrl, errorResponse, unauthorized } from "@/lib/http";

// The agent asks the gate to send a message. The gate holds the channel; the agent does not.
//   { task_id, channel: "venue-inbox", to, body, declared_type? }
// The gate reads the body itself; declared_type can only make the decision stricter.
export async function POST(req: NextRequest) {
  if (!agentAuthorized(req)) return unauthorized();
  const b = (await req.json()) as { task_id?: string; channel?: string; to?: string; body?: string; declared_type?: string };
  try {
    return NextResponse.json(
      await sendMessage({ task_id: b.task_id, channel: String(b.channel ?? ""), to: String(b.to ?? ""), body: String(b.body ?? ""), declared_type: b.declared_type, baseUrl: baseUrl(req) }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
