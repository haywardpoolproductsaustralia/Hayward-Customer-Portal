// app/api/warranty-tickets/route.ts
//
// Returns the logged-in customer's warranty tickets (those carrying a Packing
// Slip Number in Freshdesk), each with its Arrow order lines enriched with the
// LIVE stock snapshot: on-hand, backordered, and incoming ETA.
//
// warranty:tickets:{code} and warranty:tickets:group:{groupKey} are written by
// portal-sync/sync-warranty-tickets.js (slip + order lines, no stock). Stock is
// joined here at read time. Incoming/ETA is read from incoming:all (the same
// key /api/stock reads) rather than stock.incoming, so a stock-sync rewrite
// can't wipe it.

import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
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
    available, // free-to-sell
    backordered,
    onOrder: inc?.onOrderQty || 0, // qty on open supplier POs
    nextEta: inc?.nextEta || null, // when the next inbound delivery is due
    deliveries: inc?.deliveries || [], // full [{ eta, qty }] schedule
    inStock: available > 0,
  };
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  try {
    // 1) Gather this login's warranty tickets.
    //    Prefer the pre-built group rollup (one read); fall back to per-code.
    let tickets: any[] = [];

    const rollup = await getJSON<any[]>(`warranty:tickets:group:${access.groupKey}`);
    if (rollup) {
      tickets = rollup;
    } else if (access.customerCodes.length) {
      // chunked mget so an aggregate login (every code) can't overrun a request
      const CHUNK = 500;
      for (let i = 0; i < access.customerCodes.length; i += CHUNK) {
        const chunk = access.customerCodes.slice(i, i + CHUNK);
        const keys = chunk.map((c) => `warranty:tickets:${c}`);
        const res = await redis.mget<(string | null)[]>(...keys);
        for (const r of res) tickets.push(...parseArray(r));
      }
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
      packingSlip: t.packingSlip, // = sales order number
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

    // newest activity first
    enriched.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

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
function parseArray(raw: unknown): any[] {
  if (!raw) return [];
  const v = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(v) ? v : [];
}
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
