import { NextRequest, NextResponse } from 'next/server';
import { redis, getJSON } from '@/lib/redis';
import {
  getCustomerAccess,
  resolveStockScope,
  stockViewFilter,
  parseStockView,
  stockKeysForSku,
  STOCK_KEY_PREFIX,
  STOCK_VIEW_LABEL,
} from '@/lib/access';

interface IncomingInfo {
  onOrderQty: number;
  nextEta: string | null;
  deliveries: { eta: string | null; qty: number }[];
}

interface StockEntry {
  byLocation: Record<string, { onHand: number; allocated: number; backordered: number }>;
  stockCategory?: string | null;
  supplierCode?: string | null;
  incoming?: IncomingInfo;
  updatedAt: string;
}

// Incoming supply lives in its own Redis key (`incoming:all`, written by
// portal-sync's sync-incoming.js) rather than being folded into stock:all, so
// the 15-minute stock sync rewriting stock:all can't wipe it out. We merge it
// in here at read time. Map is { "<SKU>": IncomingInfo }.
type IncomingMap = Record<string, IncomingInfo>;

// ---------------------------------------------------------------------------
// This route was previously UNGATED - it read stock:all and returned it to any
// caller with no getCustomerAccess() check, unlike /api/pricing and
// /api/forecast which both gate. That was survivable while every org was
// entitled to the whole Hayward catalogue, but Paramount (pr:stock:*) is
// restricted to Poolwater Products, Compass and Hayward staff, so the gate is
// now load-bearing. Do not remove it.
//
// Every key this route touches comes from resolveStockScope() or
// stockKeysForSku(), both of which intersect against access.catalogues. There
// is no path here that can construct a pr: key for an org without permission,
// including the ?sku= and ?prefix= branches.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const sku = searchParams.get('sku')?.trim().toUpperCase();
  const prefix = searchParams.get('prefix')?.trim().toUpperCase();

  const scope = resolveStockScope(access, parseStockView(searchParams));
  const matchesView = stockViewFilter(scope);

  // Echoed on every response so the UI can render the filter row without a
  // second round trip, and so the applied view is always visible even when it
  // was clamped away from what the caller asked for.
  const viewMeta = {
    view: scope.view,
    availableViews: scope.availableViews,
    viewLabels: STOCK_VIEW_LABEL,
    includesParamount: scope.includesParamount,
  };

  const incoming = (await getJSON<IncomingMap>('incoming:all')) ?? {};

  if (sku) {
    // Only catalogues this org holds are probed, so a distributor cannot
    // discover a Paramount SKU by guessing its part number - they get the same
    // 404 as for a SKU that doesn't exist.
    for (const key of stockKeysForSku(access, sku)) {
      const entry = await getJSON<StockEntry>(key);
      if (entry) {
        return NextResponse.json({
          sku,
          ...entry,
          incoming: incoming[sku] ?? entry.incoming,
          ...viewMeta,
        });
      }
    }
    return NextResponse.json({ error: 'SKU not found' }, { status: 404 });
  }

  if (prefix) {
    // KEYS is run once per permitted catalogue. Note pr:stock:* would never be
    // matched by a stock:* pattern anyway, but relying on prefix ordering for
    // isolation would be luck rather than design - the loop is over the
    // catalogues the org actually holds.
    const perCatalogue = await Promise.all(
      scope.catalogues.map(async (catalogue) => {
        const keyPrefix = STOCK_KEY_PREFIX[catalogue];
        const keys = await redis.keys(`${keyPrefix}${prefix}*`);
        return { keyPrefix, keys };
      })
    );

    const flat = perCatalogue.flatMap(({ keyPrefix, keys }) =>
      keys.map((key) => ({ keyPrefix, key }))
    );
    const limited = flat.slice(0, 50);

    const results = (
      await Promise.all(
        limited.map(async ({ keyPrefix, key }) => {
          const entry = await getJSON<StockEntry>(key);
          const entrySku = key.slice(keyPrefix.length);
          return { sku: entrySku, ...entry, incoming: incoming[entrySku] ?? entry?.incoming };
        })
      )
    ).filter(matchesView);

    return NextResponse.json({ results, truncated: flat.length > 50, ...viewMeta });
  }

  // No filter at all: the full list, in one read per catalogue, for the
  // portal's "show everything, filter as you type" view. Hayward SKUs sort
  // ahead of Paramount because resolveStockScope pins that key order.
  const lists = await Promise.all(
    scope.keys.map((key) => getJSON<(StockEntry & { sku: string })[]>(key))
  );

  const merged = lists
    .flatMap((list) => list ?? [])
    .filter(matchesView)
    .map((entry) => ({
      ...entry,
      incoming: incoming[entry.sku] ?? entry.incoming,
    }));

  return NextResponse.json({ results: merged, truncated: false, ...viewMeta });
}
