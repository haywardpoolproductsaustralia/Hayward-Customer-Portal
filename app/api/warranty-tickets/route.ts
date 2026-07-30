// app/api/warranty-tickets/route.ts
//
// Returns the logged-in customer's warranty tickets (those carrying a Packing
// Slip Number in Freshdesk), each with its Arrow order lines enriched with the
// LIVE stock snapshot: on-hand, backordered, and incoming ETA.
//
// The warranty:tickets:* keys are written by sync-warranty-tickets.js (slip +
// order lines, no stock). Stock is joined here at read time so quantities and
// ETAs are always the freshest snapshot (stock syncs every ~15 min, tickets
// less often). This mirrors how the rest of the portal reads from Redis.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { redis } from '@/lib/redis';

// Match the AU locations the stock sync writes (ARROW_LOCATIONS).
const STOCK_LOCATIONS = (process.env.ARROW_LOCATIONS || '1-MEL,2-MEL')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type StockEntry = {
  name: string | null;
  byLocation: Record<string, { onHand: number; allocated: number; backordered: number }>;
  incoming?: { onOrderQty: number; nextEta: string | null; deliveries: { eta: string | null; qty: number }[] };
};

function summariseStock(stock: StockEntry | null) {
  if (!stock) {
    return { onHand: 0, allocated: 0, backordered: 0, onOrder: 0, nextEta: null, deliveries: [], inStock: false };
  }
  let onHand = 0;
  let allocated = 0;
  let backordered = 0;
  for (const loc of STOCK_LOCATIONS) {
    const l = stock.byLocation?.[loc];
    if (!l) continue;
    onHand += l.onHand || 0;
    allocated += l.allocated || 0;
    backordered += l.backordered || 0;
  }
  const inc = stock.incoming;
  return {
    onHand,
    allocated,
    available: onHand - allocated, // free-to-sell
    backordered,
    onOrder: inc?.onOrderQty || 0, // qty on open supplier POs
    nextEta: inc?.nextEta || null, // when the next inbound delivery is due
    deliveries: inc?.deliveries || [], // [{ eta, qty }] for a full schedule
    inStock: onHand - allocated > 0,
  };
}

export async function GET() {
  const { userId, orgId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 1) Which warranty tickets belong to this login?
    //    Head-office orgs map to a group; read the one rollup key. Otherwise
    //    fall back to the org's individual customer codes.
    let tickets: any[] = [];

    // If you store a group name per org, read the rollup in one hit:
    const groupName = orgId ? await redis.get<string>(`org:${orgId}:group`) : null;
    if (groupName) {
      const raw = await redis.get(`warranty:tickets:group:${groupName}`);
      tickets = parseArray(raw);
    } else {
      // Fall back: expand the org to its customer codes and gather per-code keys.
      const codesRaw = orgId ? await redis.get(`org:${orgId}:codes`) : null;
      const codes: string[] = parseArray(codesRaw);
      if (codes.length) {
        const keys = codes.map((c) => `warranty:tickets:${c}`);
        const results = await redis.mget<(string | null)[]>(...keys);
        tickets = results.flatMap((r) => parseArray(r));
      }
    }

    if (tickets.length === 0) {
      return NextResponse.json({ count: 0, tickets: [], fetchedAt: new Date().toISOString() });
    }

    // 2) Join live stock for every SKU referenced across these tickets.
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
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      url: t.url,
      warranty: t.warranty, // contact person / phone / pool owner etc.
      lines: (t.lines || []).map((l: any) => {
        const stock = summariseStock(stockMap.get(l.sku) || null);
        return {
          sku: l.sku,
          description: l.description,
          qtyOrdered: l.qtyOrdered,
          qtyShipped: l.qtyShipped,
          qtyBackordered: l.qtyBackordered,
          stock, // { onHand, available, backordered, onOrder, nextEta, deliveries, inStock }
        };
      }),
    }));

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
  return { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' }[code] || 'Unknown';
}
