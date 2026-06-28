import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/orders-auth";
import { seedSampleOrders } from "@/lib/orders-seed";

/**
 * POST /api/orders/seed  — inserts the sample orders so you can test the queue.
 * Safe to call more than once (createOrder dedupes on message id).
 * Delete this file once the real email pipeline is feeding the queue.
 */
export async function POST() {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const count = await seedSampleOrders();
  return NextResponse.json({ ok: true, seeded: count });
}
