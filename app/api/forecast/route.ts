import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';
import type { DemandBucket } from '@/lib/forecast';

// One record per SKU, pre-computed by portal-sync and written to the
// `forecast:all` key. The app never recomputes forecasts on the request path
// or touches Arrow SQL - it reads this the same way the Stock page reads
// `stock:all`. See sql/forecast-demand-series.sql and the portal-sync glue
// in docs/forecasting.md for how this key is produced.
export interface ForecastRecord {
  sku: string;
  name: string | null;
  stockCategory: string | null;

  supplierCode: string | null;
  supplierName: string | null;
  supplierStock: string | null;

  bucket: DemandBucket;
  method: string;
  adi: number;
  cv2: number;

  history: number[];        // trailing monthly demand (qty), oldest -> newest
  historyStart: string;     // 'YYYY-MM' of history[0]
  forecast: number[];       // next-N months
  monthlyForecast: number;  // headline rate (avg of horizon)
  monthlyStd: number;

  // Stock position - 1-MEL + 2-MEL only, per the warehouse rule.
  onHand: number;
  onOrder: number;
  allocated: number;
  backordered: number;
  position: number;

  leadTimeDays: number;
  avgCost: number;

  reorderPoint: number;
  safetyStock: number;
  suggestedQty: number;
  suggestedValue: number;   // suggestedQty * avgCost
  coverMonths: number;
  belowReorder: boolean;

  // Arrow's own static settings, for "is the manual min still sensible?"
  arrowReorderQty: number;
  arrowMinimumQty: number;

  wmape: number | null;
  bias: number;
}

interface ForecastMeta {
  generatedAt: string;
  horizonMonths: number;
  historyMonths: number;
  serviceLevelPct: number;
  locations: string[];
}

export interface ForecastResponse {
  records: ForecastRecord[];
  suppliers: string[];
  categories: string[];
  meta: ForecastMeta | null;
  summary: {
    totalSkus: number;
    needReorder: number;
    stockoutRisk: number;       // below reorder AND under 1 month cover
    totalSuggestedValue: number;
    deadStock: number;          // on hand but classified dead
  };
}

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }
  // Demand forecasting is internal supply-side planning (shows cost, supplier,
  // and buy quantities) - never exposed to distributor logins.
  if (!access.isAggregate) {
    return NextResponse.json(
      { error: 'Forecasting is only available to internal staff' },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const supplier = searchParams.get('supplier')?.trim() || null;
  const category = searchParams.get('category')?.trim() || null;
  const bucket = searchParams.get('bucket')?.trim() || null;
  const needReorderOnly = searchParams.get('needReorder') === '1';

  const [all, meta] = await Promise.all([
    getJSON<ForecastRecord[]>('forecast:all'),
    getJSON<ForecastMeta>('forecast:meta'),
  ]);

  const records = all ?? [];

  const suppliers = [...new Set(records.map((r) => r.supplierName).filter(Boolean) as string[])].sort();
  const categories = [...new Set(records.map((r) => r.stockCategory).filter(Boolean) as string[])].sort();

  const filtered = records.filter((r) => {
    if (supplier && r.supplierName !== supplier) return false;
    if (category && r.stockCategory !== category) return false;
    if (bucket && r.bucket !== bucket) return false;
    if (needReorderOnly && !r.belowReorder) return false;
    return true;
  });

  // Most urgent first: the things closest to running out.
  filtered.sort((a, b) => a.coverMonths - b.coverMonths);

  const summary = {
    totalSkus: filtered.length,
    needReorder: filtered.filter((r) => r.belowReorder).length,
    stockoutRisk: filtered.filter((r) => r.belowReorder && r.coverMonths < 1).length,
    totalSuggestedValue: filtered.reduce((s, r) => s + (r.suggestedValue || 0), 0),
    deadStock: filtered.filter((r) => r.bucket === 'dead' && r.onHand > 0).length,
  };

  const body: ForecastResponse = { records: filtered, suppliers, categories, meta, summary };
  return NextResponse.json(body);
}
