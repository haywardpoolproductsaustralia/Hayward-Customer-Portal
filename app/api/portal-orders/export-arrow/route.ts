import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { getPortalOrder, markExported, ExportSkipReason, PortalOrder } from "@/lib/portal-orders";
import { buildArrowCsv } from "@/lib/arrow-csv";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal-orders/export-arrow   { ids: string[], force?: boolean }
 *
 * Builds the Arrow sales-order import CSV for the given portal orders and marks
 * each one exported IN THE SAME STEP, so the same order can't be pulled into
 * two files by two people (or one double-click) and imported into Arrow twice.
 *
 * Orders that must not go to Arrow are skipped and reported back rather than
 * failing the whole export: cancelled, keyed by hand, already seen in Arrow,
 * already exported (unless force), or claimed by someone else right now.
 *
 * Staff only - same requireAgent() gate as the rest of the queue.
 */

const MAX_ORDERS = 200;

const REASON_TEXT: Record<ExportSkipReason, string> = {
  not_found: "no longer exists",
  cancelled: "was cancelled",
  keyed: "was keyed into Arrow by hand",
  in_arrow: "is already in Arrow",
  exported: "was already exported - use its own Download CSV button to export it again",
  claimed: "is claimed by someone who may be keying it",
};

export async function POST(req: Request) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; force?: unknown };
  const ids = Array.isArray(body.ids)
    ? Array.from(new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length > 0)))
    : [];
  if (ids.length === 0) return NextResponse.json({ error: "No orders selected." }, { status: 400 });
  if (ids.length > MAX_ORDERS) {
    return NextResponse.json({ error: `Export at most ${MAX_ORDERS} orders at a time.` }, { status: 400 });
  }
  const force = body.force === true;

  const exported: PortalOrder[] = [];
  const skipped: { id: string; ref: string | null; reason: string }[] = [];

  // Sequential on purpose: each mark is atomic on its own, and a few hundred
  // Redis round trips is nothing next to the cost of a duplicate sales order.
  for (const id of ids) {
    const before = await getPortalOrder(id);
    const res = await markExported(id, agent.userId, agent.name, force);
    if (!res.ok) {
      skipped.push({ id, ref: before?.ref ?? null, reason: REASON_TEXT[res.reason] });
      continue;
    }
    const order = await getPortalOrder(id);
    if (order) exported.push(order);
  }

  // Oldest first, so Arrow order numbers follow the order customers placed them.
  exported.sort((a, b) => a.submittedAt - b.submittedAt);

  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(/[^0-9]/g, "")
    .replace(/^(\d{8})(\d{4})$/, "$1-$2");

  return NextResponse.json({
    csv: exported.length > 0 ? buildArrowCsv(exported) : null,
    filename: `arrow-sales-orders-${stamp}.csv`,
    exported: exported.map((o) => ({ id: o.id, ref: o.ref, lines: o.lines.length })),
    skipped,
  });
}
