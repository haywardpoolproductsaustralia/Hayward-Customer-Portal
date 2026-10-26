// app/api/containers/view/route.ts
// GET — everything the Purchasing page needs to draw tracking under each row: every open container record
// (facts + live ShipsGo status + the PO lines inside), plus the last ingest/refresh summaries.
// Closed boxes (gate-out / delivered / ETA > 60 days ago) are left out to keep the payload small.
// Staff only — distributor orgs never see container-level purchasing data.

import { NextResponse } from "next/server";
import { getCustomerAccess } from "@/lib/access";
import { getJSON } from "@/lib/redis";
import { getAllRecords, isClosed, K } from "@/lib/containers/store";
import { CONTAINER_ORDERS_KEY, loadContainerLinks, type ContainerOrderRaw } from "@/lib/container-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  if (!access.isAggregate) return NextResponse.json({ containers: [], meta: null, refresh: null });

  const [records, meta, refresh, orders, links] = await Promise.all([
    getAllRecords(), getJSON<any>(K.meta), getJSON<any>(K.refresh).then(async (r) => ({ ...(r ?? {}), cronHit: await getJSON<any>("ct:cronhit") })),
    getJSON<ContainerOrderRaw[]>(CONTAINER_ORDERS_KEY).catch(() => null), loadContainerLinks().catch(() => ({} as Record<string, string>)),
  ]);
  // Who each PO is for — from the Container orders join (Arrow SO ↔ PO), so the Purchasing panel can say
  // "for POOL & SPA WAREHOUSE (SO 446899, direct)" even when nothing on the box itself names the customer.
  const poCustomers: Record<string, { customer: string; customerCode?: string; so?: string; direct: boolean; deliverTo?: string }> = {};
  for (const o of Array.isArray(orders) ? orders : []) {
    const so = o.so;
    const direct = o.shipTo === "customer";
    if (so) poCustomers[o.po] = { customer: so.customerName, customerCode: so.customerCode, so: so.orderNo, direct, deliverTo: so.address?.lines?.slice(0, 3).join(", ") || undefined };
    else if (direct && o.poDeliveryAddress?.length) poCustomers[o.po] = { customer: o.poDeliveryAddress[0], direct, deliverTo: o.poDeliveryAddress.slice(0, 3).join(", "), so: links[o.po] };
    else if (links[o.po]) poCustomers[o.po] = { customer: `SO ${links[o.po]} (pinned — details after next sync)`, so: links[o.po], direct };
  }
  const containers = records
    .filter((r) => !isClosed(r, 60, false))
    .map((r) => ({ ...r, lines: r.lines.map((l) => ({ po: l.po, item: l.supplierItem, qty: l.qty, source: l.source, ref: l.sourceRef })) }))
    .sort((a, b) => (a.live?.eta ?? a.eta ?? "9999").localeCompare(b.live?.eta ?? b.eta ?? "9999"));
  return NextResponse.json({ containers, total: records.length, meta, refresh, poCustomers, shipsgoConfigured: !!process.env.SHIPSGO_USER_TOKEN });
}
