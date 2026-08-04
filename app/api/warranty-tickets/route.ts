// app/api/warranty-tickets/route.ts
//
// Warranty tickets for the logged-in account, each line enriched with the LIVE
// stock snapshot (on-hand, backordered, on-order + ETA).
//
// The sync writes ONE key, warranty:tickets:all (every matched ticket, each
// carrying its customerCode). We scope it here per login:
//   Hayward staff (aggregate org) -> all of it
//   every other company           -> only tickets whose customerCode is theirs
//   groups in HIDDEN_PAGES        -> 403, nothing at all
//
// That last case is the same rule the nav and the page enforce
// (lib/page-visibility.ts). It lives here too because hiding a link and
// redirecting a page still leaves this endpoint returning JSON to anyone with
// a session who knows the URL.
//
// Stock is joined at read time; incoming/ETA comes from incoming:all (same as
// /api/stock) so a stock-sync rewrite can't wipe it.

import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { isPageHidden } from '@/lib/page-visibility';
import { redis, getJSON } from '@/lib/redis';

export const dynamic = 'force-dynamic';

const STOCK_LOCATIONS = (process.env.ARROW_LOCATIONS || '1-MEL,2-MEL')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface IncomingInfo {
  onOrderQty: number;
  nextEta: string | null;
  deliveries: { eta: string | null; qty: number }[];
}
interface StockEntry {
  byLocation: Record<string, { onHand: number; allocated: number; backordered: number }>;
  incoming?: IncomingInfo;
}
type IncomingMap = Record<string, IncomingInfo>;

function summariseStock(stock: StockEntry | null, incoming: IncomingInfo | undefined) {
  let onHand = 0;
  let allocated = 0;
  let backordered = 0;
  if (stock) {
    for (const loc of STOCK_LOCATIONS) {
      const l = stock.byLocation?.[loc];
      if (!l) continue;
      onHand += l.onHand || 0;
      allocated += l.allocated || 0;
      backordered += l.backordered || 0;
    }
  }
  const inc = incoming ?? stock?.incoming;
  const available = onHand - allocated;
  return {
    onHand,
    allocated,
    available,
    backordered,
    onOrder: inc?.onOrderQty || 0,
    nextEta: inc?.nextEta || null,
    deliveries: inc?.deliveries || [],
    inStock: available > 0,
  };
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  // This group has the warranty page turned off (see lib/page-visibility.ts).
  if (isPageHidden('/dashboard/warranty', access.groupKey, access.isAggregate)) {
    return NextResponse.json({ error: 'Not available for this account' }, { status: 403 });
  }

  try {
    // 1) Load the all-tickets snapshot, then scope to this login.
    const all = (await getJSON<any[]>('warranty:tickets:all')) ?? [];

    let tickets: any[];
    if (access.isAggregate) {
      tickets = all; // Hayward staff see everything
    } else {
      const codes = new Set(access.customerCodes);
      tickets = all.filter((t) => codes.has(t.customerCode)); // own tickets only
    }

    if (tickets.length === 0) {
      return NextResponse.json({ count: 0, tickets: [], fetchedAt: new Date().toISOString() });
    }

    // 2) Join live stock + incoming for every SKU referenced.
    const incomingMap = (await getJSON<IncomingMap>('incoming:all')) ?? {};
    const skus = [...new Set(tickets.flatMap((t) => (t.lines || []).map((l: any) => l.sku)))];
    const stockMap = new Map<string, StockEntry | null>();
    if (skus.length) {
      const stockKeys = skus.map((s) => `stock:${s}`);
      const stockRaw = await redis.mget<(string | null)[]>(...stockKeys);
      skus.forEach((sku, i) => stockMap.set(sku, parseObject(stockRaw[i])));
    }

    const enriched = tickets.map((t) => ({
      ticketId: t.ticketId,
      subject: t.subject,
      status: statusLabel(t.status),
      packingSlip: t.packingSlip,
      customerCode: t.customerCode,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      url: t.url,
      warranty: t.warranty,
      lines: (t.lines || []).map((l: any) => ({
        sku: l.sku,
        description: l.description,
        qtyOrdered: l.qtyOrdered,
        qtyShipped: l.qtyShipped,
        qtyBackordered: l.qtyBackordered,
        stock: summariseStock(stockMap.get(l.sku) || null, incomingMap[l.sku]),
      })),
    }));

    // Open/Pending first, then newest-logged within each status.
    const statusRank = (s: string) =>
      ({ Open: 0, Pending: 1, Resolved: 2, Closed: 3 } as Record<string, number>)[s] ?? 4;
    enriched.sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      return r !== 0 ? r : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return NextResponse.json({
      count: enriched.length,
      tickets: enriched,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('warranty-tickets route error:', err);
    return NextResponse.json({ error: 'Failed to load warranty tickets' }, { status: 500 });
  }
}

// --- helpers ---------------------------------------------------------------
function parseObject(raw: unknown): any {
  if (!raw) return null;
  return typeof raw === 'string' ? safeJson(raw) : raw;
}
function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function statusLabel(code: number) {
  return ({ 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' } as Record<number, string>)[code] || 'Unknown';
}
