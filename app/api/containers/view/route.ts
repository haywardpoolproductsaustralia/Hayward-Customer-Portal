// app/api/containers/view/route.ts
// GET — everything the Purchasing page needs to draw tracking under each row: every open container record
// (facts + live ShipsGo status + the PO lines inside), plus the last ingest/refresh summaries.
// Closed boxes (gate-out / delivered / ETA > 60 days ago) are left out to keep the payload small.
// Staff only — distributor orgs never see container-level purchasing data.

import { NextResponse } from "next/server";
import { getCustomerAccess } from "@/lib/access";
import { getJSON } from "@/lib/redis";
import { getAllRecords, isClosed, K } from "@/lib/containers/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  if (!access.isAggregate) return NextResponse.json({ containers: [], meta: null, refresh: null });

  const [records, meta, refresh] = await Promise.all([getAllRecords(), getJSON<any>(K.meta), getJSON<any>(K.refresh).then(async (r) => ({ ...(r ?? {}), cronHit: await getJSON<any>("ct:cronhit") }))]);
  const containers = records
    .filter((r) => !isClosed(r, 60, false))
    .map((r) => ({ ...r, lines: r.lines.map((l) => ({ po: l.po, item: l.supplierItem, qty: l.qty, source: l.source, ref: l.sourceRef })) }))
    .sort((a, b) => (a.live?.eta ?? a.eta ?? "9999").localeCompare(b.live?.eta ?? b.eta ?? "9999"));
  return NextResponse.json({ containers, total: records.length, meta, refresh, shipsgoConfigured: !!process.env.SHIPSGO_USER_TOKEN });
}
