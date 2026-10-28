// app/api/recon/arrow/route.ts
import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getCustomerAccess, PARAMOUNT_CATEGORY } from '@/lib/access';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

interface ArrowLine {
  po: string;
  line: number;
  arrowStock: string;
  supplierSku: string;
  description: string | null;
  stockCategory: string;
  creditor: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  qtyOutstanding: number;
  orderDate: string | null;
  requestedDate: string | null;
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access?.canAccessReconciliation) {
    return NextResponse.json(
      { error: 'Unauthorized: reconciliation access required' },
      { status: 403 }
    );
  }

  try {
    const [rawLines, rawMeta] = await Promise.all([
      redis.get('recon:arrow_open_pos'),
      redis.get('recon:arrow_meta'),
    ]);

    let lines = rawLines
      ? (typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines)
      : [];

    if (!access.isAggregate && Array.isArray(lines)) {
      lines = (lines as ArrowLine[]).filter((line) =>
        (line.stockCategory ?? '').trim().toUpperCase() === PARAMOUNT_CATEGORY
      );
    }

    // Stock on hand from the 15-minute stock sync (stock:all / pr:stock:all / fc:stock:all),
    // summed across locations, keyed by Arrow stock code. Attached per line as onHand / allocated / backordered.
    try {
      const lists = await Promise.all(['stock:all', 'pr:stock:all', 'fc:stock:all'].map((k) => redis.get(k)));
      const soh = new Map<string, { onHand: number; allocated: number; backordered: number }>();
      // Product name exactly as the Products page shows it (STOCK_NAME_1 from the stock sync). The Arrow PO extract
      // only carries STOCK_NAME_2 — a secondary line ("CPVC", "SWIMCLEAR") that is blank for most Paramount SKUs.
      const names = new Map<string, string>();
      for (const raw of lists) {
        const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
        if (!Array.isArray(list)) continue;
        for (const e of list as any[]) {
          const sku = String(e?.sku ?? '').trim().toUpperCase();
          if (!sku) continue;
          const t = { onHand: 0, allocated: 0, backordered: 0 };
          for (const loc of Object.values((e?.byLocation ?? {}) as Record<string, any>)) {
            t.onHand += Number(loc?.onHand ?? 0) || 0;
            t.allocated += Number(loc?.allocated ?? 0) || 0;
            t.backordered += Number(loc?.backordered ?? 0) || 0;
          }
          soh.set(sku, t);
          const nm = String(e?.name ?? '').trim();
          if (nm && !names.has(sku)) names.set(sku, nm);
        }
      }
      if (Array.isArray(lines)) {
        lines = (lines as any[]).map((l) => {
          const key = String(l.arrowStock ?? '').trim().toUpperCase();
          const t = soh.get(key);
          const nm = names.get(key);
          // Products-page name first (STOCK_NAME_1 via the stock sync); Arrow's STOCK_NAME_2 ("CPVC", "SWIMCLEAR") only as a fallback
          const description = nm || String(l.description ?? '').trim() || null;
          return { ...l, description, ...(t ? { onHand: t.onHand, allocated: t.allocated, backordered: t.backordered } : {}) };
        });
      }
    } catch { /* stock keys unavailable — lines go out without SOH */ }

    const meta = rawMeta
      ? (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta)
      : { generatedAt: null, rows: 0 };

    return NextResponse.json({
      lines,
      generatedAt: (meta as any).generatedAt ?? null,
      rows: Array.isArray(lines) ? lines.length : 0,
    });
  } catch (e: any) {
    return NextResponse.json({ lines: [], error: e.message }, { status: 500 });
  }
}
