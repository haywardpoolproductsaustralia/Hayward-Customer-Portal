import { NextResponse } from "next/server";
import { getCustomerAccess } from "@/lib/access";
import { getReconInputs } from "@/lib/recon/queries";
import { reconcile, summarize, type ReconLine } from "@/lib/recon/reconcile";

// Reconciliation is internal supply-side data (shows supplier entry, container
// costs, ETAs) — staff-only, same gate as Forecast/Warehouse. Reads the three
// recon:* keys from Redis and joins them on the request path (pure in-memory
// join, no DB, no recompute of the source data).
export const dynamic = "force-dynamic";

export interface ReconResponse {
  lines: ReconLine[];
  summary: ReturnType<typeof summarize>;
  meta: {
    generatedAt: string;
    shipmentReceivedAt: string | null;
    arrowLines: number;
    as400Rows: number;
    shipmentRows: number;
  };
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  }
  if (!access.isAggregate) {
    return NextResponse.json({ error: "Reconciliation is only available to internal staff" }, { status: 403 });
  }

  const { arrow, as400Idx, shipIdx, counts, shipmentReceivedAt } = await getReconInputs();
  const lines = reconcile(arrow, as400Idx, shipIdx);
  const summary = summarize(lines);

  const body: ReconResponse = {
    lines,
    summary,
    meta: {
      generatedAt: new Date().toISOString(),
      shipmentReceivedAt,
      arrowLines: counts.arrow,
      as400Rows: counts.as400,
      shipmentRows: counts.shipment,
    },
  };
  return NextResponse.json(body);
}
