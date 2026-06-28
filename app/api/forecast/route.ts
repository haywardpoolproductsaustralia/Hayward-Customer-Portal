import { NextRequest, NextResponse } from 'next/server';
import { redis, getJSON } from '@/lib/redis';

interface StockEntry {
  byLocation: Record<string, { onHand: number; allocated: number; backordered: number }>;
  incoming?: {
    onOrderQty: number;
    nextEta: string | null;
    deliveries: { eta: string | null; qty: number }[];
  };
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sku = searchParams.get('sku')?.trim().toUpperCase();
  const prefix = searchParams.get('prefix')?.trim().toUpperCase();

  if (sku) {
    const entry = await getJSON<StockEntry>(`stock:${sku}`);
    if (!entry) {
      return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
    }
    return NextResponse.json({ sku, ...entry });
  }

  if (prefix) {
    const keys = await redis.keys(`stock:${prefix}*`);
    const limited = keys.slice(0, 50);
    const results = await Promise.all(
      limited.map(async (key) => {
        const entry = await getJSON<StockEntry>(key);
        return { sku: key.replace('stock:', ''), ...entry };
      })
    );
    return NextResponse.json({ results, truncated: keys.length > 50 });
  }

  // No filter at all: the full list, in one read, for the portal's
  // "show everything, filter as you type" view.
  const all = (await getJSON<(StockEntry & { sku: string })[]>('stock:all')) ?? [];
  return NextResponse.json({ results: all, truncated: false });
}
