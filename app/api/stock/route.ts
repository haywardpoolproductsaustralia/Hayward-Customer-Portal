import { NextRequest, NextResponse } from 'next/server';
import { redis, getJSON } from '@/lib/redis';

interface IncomingInfo {
  onOrderQty: number;
  nextEta: string | null;
  deliveries: { eta: string | null; qty: number }[];
}

interface StockEntry {
  byLocation: Record<string, { onHand: number; allocated: number; backordered: number }>;
  incoming?: IncomingInfo;
  updatedAt: string;
}

// Incoming supply lives in its own Redis key (`incoming:all`, written by
// portal-sync's sync-incoming.js) rather than being folded into stock:all, so
// the 15-minute stock sync rewriting stock:all can't wipe it out. We merge it
// in here at read time. Map is { "<SKU>": IncomingInfo }.
type IncomingMap = Record<string, IncomingInfo>;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sku = searchParams.get('sku')?.trim().toUpperCase();
  const prefix = searchParams.get('prefix')?.trim().toUpperCase();

  const incoming = (await getJSON<IncomingMap>('incoming:all')) ?? {};

  if (sku) {
    const entry = await getJSON<StockEntry>(`stock:${sku}`);
    if (!entry) {
      return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
    }
    return NextResponse.json({ sku, ...entry, incoming: incoming[sku] ?? entry.incoming });
  }

  if (prefix) {
    const keys = await redis.keys(`stock:${prefix}*`);
    const limited = keys.slice(0, 50);
    const results = await Promise.all(
      limited.map(async (key) => {
        const entry = await getJSON<StockEntry>(key);
        const entrySku = key.replace('stock:', '');
        return { sku: entrySku, ...entry, incoming: incoming[entrySku] ?? entry?.incoming };
      })
    );
    return NextResponse.json({ results, truncated: keys.length > 50 });
  }

  // No filter at all: the full list, in one read, for the portal's
  // "show everything, filter as you type" view.
  const all = (await getJSON<(StockEntry & { sku: string })[]>('stock:all')) ?? [];
  const merged = all.map((entry) => ({
    ...entry,
    incoming: incoming[entry.sku] ?? entry.incoming,
  }));
  return NextResponse.json({ results: merged, truncated: false });
}
