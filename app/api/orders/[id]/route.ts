import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/orders-auth";
import { claimOrder, releaseOrder, markKeyed, heartbeat } from "@/lib/orders";

// Next 15: route params are async. On Next 14 use `{ params }: { params: { id: string } }`.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { action } = (await req.json()) as { action?: string };

  let result;
  switch (action) {
    case "claim":
      result = await claimOrder(id, agent.userId, agent.name);
      break;
    case "release":
      result = await releaseOrder(id, agent.userId);
      break;
    case "key":
      result = await markKeyed(id, agent.userId, agent.name);
      break;
    case "heartbeat":
      result = await heartbeat(id, agent.userId);
      break;
    default:
      return NextResponse.json({ error: "bad_action" }, { status: 400 });
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
