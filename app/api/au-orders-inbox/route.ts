import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { listIntake } from "@/lib/au-orders-inbox";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeKeyed = new URL(req.url).searchParams.get("includeKeyed") === "1";

  // Emails that are queued but not yet extracted, or that failed extraction,
  // never became orders — so they're invisible on this page and look like
  // orders that simply never arrived. Report the counts so they can't be lost
  // silently, and hand back the last few failures for diagnosis.
  const [orders, pending, failed, failedTail] = await Promise.all([
    listIntake({ includeKeyed }),
    redis.llen("soq:pending").catch(() => 0),
    redis.llen("soq:failed").catch(() => 0),
    redis.lrange<string>("soq:failed", -5, -1).catch(() => [] as string[]),
  ]);

  return NextResponse.json({
    orders,
    meId: agent.userId,
    meName: agent.name,
    queue: { pending, failed, failedTail },
  });
}
