import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import {
  claimOrder,
  releaseOrder,
  markKeyed,
  cancelOrder,
  heartbeatOrder,
} from "@/lib/portal-orders";

// Next 14 route param signature (this repo is next ^14.2.25).
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string };

  let result;
  switch (body.action) {
    case "claim":
      result = await claimOrder(id, agent.userId, agent.name);
      break;
    case "release":
      result = await releaseOrder(id, agent.userId);
      break;
    case "key":
      result = await markKeyed(id, agent.userId, agent.name);
      break;
    case "cancel": {
      const reason = (body.reason ?? "").trim().slice(0, 300);
      if (!reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });
      result = await cancelOrder(id, agent.userId, agent.name, reason);
      break;
    }
    case "heartbeat":
      result = await heartbeatOrder(id, agent.userId);
      break;
    default:
      return NextResponse.json({ error: "bad_action" }, { status: 400 });
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
