import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { claimIntake, releaseIntake, markKeyed, heartbeatIntake } from "@/lib/au-orders-inbox";

// Next 14 route param signature (this repo is next ^14.2.25).
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = params;
  const { action } = (await req.json()) as { action?: string };

  let result;
  switch (action) {
    case "claim":     result = await claimIntake(id, agent.userId, agent.name); break;
    case "release":   result = await releaseIntake(id, agent.userId); break;
    case "key":       result = await markKeyed(id, agent.userId, agent.name); break;
    case "heartbeat": result = await heartbeatIntake(id, agent.userId); break;
    default: return NextResponse.json({ error: "bad_action" }, { status: 400 });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
