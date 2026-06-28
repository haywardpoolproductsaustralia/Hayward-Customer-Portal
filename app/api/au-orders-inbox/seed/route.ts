import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { seedSampleIntake } from "@/lib/au-orders-inbox-seed";

/**
 * POST /api/au-orders-inbox/seed — inserts sample POs so you can test the queue.
 * Safe to call repeatedly (createIntake dedupes on message id). Delete after testing.
 */
export async function POST() {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const count = await seedSampleIntake();
  return NextResponse.json({ ok: true, seeded: count });
}
