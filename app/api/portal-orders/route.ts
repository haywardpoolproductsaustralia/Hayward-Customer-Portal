import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { listPortalOrders } from "@/lib/portal-orders";

export const dynamic = "force-dynamic";

/**
 * Staff-only list of customer-submitted portal orders.
 *
 * Reuses requireAgent() from the emailed-order queue deliberately: "who counts
 * as Hayward staff" should have exactly one definition, so a change to the
 * aggregate org ID can never leave one queue open and the other closed.
 */
export async function GET(req: Request) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeClosed = new URL(req.url).searchParams.get("includeClosed") === "1";
  const orders = await listPortalOrders({ includeClosed });

  return NextResponse.json({ orders, meId: agent.userId, meName: agent.name });
}
