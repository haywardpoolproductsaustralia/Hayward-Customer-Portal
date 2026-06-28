import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { listIntake } from "@/lib/au-orders-inbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeKeyed = new URL(req.url).searchParams.get("includeKeyed") === "1";
  const orders = await listIntake({ includeKeyed });
  return NextResponse.json({ orders, meId: agent.userId, meName: agent.name });
}
