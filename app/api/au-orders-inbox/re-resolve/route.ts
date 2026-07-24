import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { getJSON } from "@/lib/redis";
import { reResolveIntake } from "@/lib/au-orders-inbox";
import { reResolveCustomer } from "@/lib/au-orders-extract";

export const dynamic = "force-dynamic";

/**
 * Re-run the customer match over records already in the queue.
 *
 * The debtor is decided at ingest, so improving the matcher leaves everything
 * already queued showing the old answer. This recomputes it from the fields
 * stored on each record — no extraction model call, so SKUs, quantities and
 * prices are untouched and it costs nothing to run.
 *
 * POST with { commit: false } (the default) to PREVIEW: it returns exactly what
 * would change and writes nothing. Send { commit: true } to apply.
 *
 * Preview-by-default is deliberate. This rewrites live records in bulk, and a
 * matcher change that fixes ten orders could just as easily move an eleventh
 * that was already right. Seeing the list first is the difference between a
 * correction and a second incident.
 */
export async function POST(req: Request) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const commit = body?.commit === true;
  const includeKeyed = body?.includeKeyed === true;

  const [customerNames, customerProfiles] = await Promise.all([
    getJSON<Record<string, string>>("customerNames"),
    getJSON<Record<string, never>>("customerProfiles"),
  ]);

  // Without the customer file there is nothing to match against, and running
  // anyway would blank every debtor on the queue.
  if (!customerNames || Object.keys(customerNames).length === 0) {
    return NextResponse.json(
      { error: "customerNames is empty in Redis — run the portal-sync customer job first." },
      { status: 503 }
    );
  }

  const summary = await reResolveIntake(
    (rec) => reResolveCustomer(rec, customerNames, (customerProfiles ?? {}) as Record<string, never>),
    { commit, includeKeyed }
  );

  return NextResponse.json(summary);
}
