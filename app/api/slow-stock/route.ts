import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';
import type { ForecastRecord } from '@/app/api/forecast/route';

// ---------------------------------------------------------------------------
// Slow-moving stock
// ---------------------------------------------------------------------------
// This is the portal version of the old "slow_moving_stock.xlsx" workbook.
// That sheet pulled 24 months of sales per SKU by SQL, divided by 24 for a
// flat monthly rate, and called anything on hand beyond 12 (or 24) months of
// that rate "excess", valued at AVERAGE_COST. Same maths here, same column
// names in the export - plus the things the sheet could not do:
//
//   * aging       - months since the SKU last sold (so "slow" and "dead" are
//                   separated; they need different actions)
//   * seasonal    - cover measured against the seasonal forecast, not a flat
//                   average, so heaters aren't flagged every February
//   * on order    - inbound POs counted in the position, and a flag when we
//                   are buying more of something already in excess
//   * action      - a recommended next step per SKU
//
// Reads the nightly `forecast:all` key written by sync-forecast.js on AZ-Grey.
// Nothing here touches Arrow SQL. Demand in that key is NATIONAL invoiced
// sales (DRINV less DRCDT); on hand / on order are 1-MEL + 2-MEL only, the
// same convention the Forecast page uses.

export type SlowAction = 'clear' | 'stop-buying' | 'review' | 'ok';
export type AgeBand = '<12m' | '12-24m' | '24-36m' | '36m+';

export interface SlowStockRecord {
  sku: string;
  name: string | null;
  stockCategory: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  supplierStock: string | null;

  // position (1-MEL + 2-MEL)
  onHand: number;
  onOrder: number;
  backordered: number;
  position: number;           // onHand + onOrder
  avgCost: number;
  stockValue: number;         // onHand * avgCost
  positionValue: number;      // (onHand + onOrder) * avgCost

  // demand
  sales12: number;            // units, trailing 12 months
  sales24: number;            // units, trailing 24 months  (old sheet: SalesQty_24Months)
  sales36: number;
  avgMonthly24: number;       // old sheet: AvgMonthly Sales_24M
  history: number[];          // 36 monthly buckets, oldest -> newest
  historyStart: string;       // 'YYYY-M' of history[0]

  // aging
  monthsSinceLastSale: number | null;  // null = nothing in the 36m window
  lastSale: string | null;             // ISO date from STKMAST.LAST_SALE if the sync provides it
  lastPurchase: string | null;
  ageBand: AgeBand;

  // cover
  coverFlat: number | null;       // onHand / avgMonthly24   (old sheet logic), null when no sales
  coverSeasonal: number | null;   // months until the seasonal forecast consumes onHand + onOrder
  bucket: ForecastRecord['bucket'];

  // excess - the old sheet's numbers, verbatim
  excessQty12: number;            // onHand - avgMonthly24*12  (floored at 0)
  excessValue12: number;
  excessQty24: number;
  excessValue24: number;
  // and the seasonal version: whatever on hand + on order won't be used in the horizon
  excessQtySeasonal12: number;
  excessValueSeasonal12: number;

  buyingWhileExcess: boolean;     // onOrder > 0 AND excessQty12 > 0
  action: SlowAction;
  reason: string;
}

export interface SupplierSummary {
  supplierName: string;
  supplierCode: string | null;
  skus: number;
  stockValue: number;
  excessValue12: number;
  deadValue: number;
  onOrderValue: number;
}

export interface SlowStockResponse {
  records: SlowStockRecord[];
  suppliers: string[];
  categories: string[];
  meta: { generatedAt: string; historyMonths: number; locations: string[] } | null;
  thresholds: { slowMonths: number; deadMonths: number };
  summary: {
    skusOnHand: number;
    stockValue: number;
    excessValue12: number;
    excessValue24: number;
    excessValueSeasonal12: number;
    deadSkus: number;
    deadValue: number;
    buyingWhileExcessSkus: number;
    buyingWhileExcessValue: number;    // on-order value of those SKUs
    skusTo50pct: number;               // concentration of excessValue12
    skusTo80pct: number;
    byAction: Record<SlowAction, { skus: number; stockValue: number }>;
    byAge: Record<AgeBand, { skus: number; stockValue: number }>;
    bySupplier: SupplierSummary[];
  };
}

// --- helpers ---------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;
const r0 = (n: number) => Math.round(n);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

// Arrow's "no date" sentinel is 1753-01-01; the sync maps it to null but be
// defensive about anything pre-2000 that slips through.
function cleanDate(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
  return d.toISOString().slice(0, 10);
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

// Months since the last non-zero month in the history array. 0 = sold this
// month. null = no sale anywhere in the window.
function monthsSinceLastNonZero(history: number[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] > 0) return history.length - 1 - i;
  }
  return null;
}

// Months until the seasonal forecast eats the position. Uses the 6-month
// forecast then the headline monthly rate beyond it. Capped at 120.
function seasonalCover(position: number, forecast: number[], monthlyForecast: number): number | null {
  if (position <= 0) return 0;
  let remaining = position;
  let months = 0;
  for (const f of forecast) {
    if (f >= remaining) return r1(months + remaining / f);
    remaining -= f;
    months += 1;
  }
  if (monthlyForecast <= 0) return null;   // infinite - no demand expected
  const extra = remaining / monthlyForecast;
  return r1(Math.min(120, months + extra));
}

function ageBand(m: number | null, sinceLastSale: number | null): AgeBand {
  const n = m ?? sinceLastSale;
  if (n == null) return '36m+';
  if (n < 12) return '<12m';
  if (n < 24) return '12-24m';
  if (n < 36) return '24-36m';
  return '36m+';
}

// --- main --------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }
  // Cost, supplier and excess-stock figures are internal. Same gate as /api/forecast.
  if (!access.isAggregate) {
    return NextResponse.json(
      { error: 'Slow-moving stock is only available to internal staff' },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const supplier = searchParams.get('supplier')?.trim() || null;
  const category = searchParams.get('category')?.trim() || null;
  const action = (searchParams.get('action')?.trim() || null) as SlowAction | null;
  const age = (searchParams.get('age')?.trim() || null) as AgeBand | null;
  const q = searchParams.get('q')?.trim().toUpperCase() || null;
  const includeZero = searchParams.get('includeZero') === '1';   // SKUs with no stock on hand

  // Thresholds, in months of cover. Defaults match the old sheet: beyond 12
  // months is "slow/excess"; nothing sold in 24 months is "dead".
  const slowMonths = Math.max(1, Number(searchParams.get('slowMonths')) || 12);
  const deadMonths = Math.max(1, Number(searchParams.get('deadMonths')) || 24);

  const [all, meta] = await Promise.all([
    getJSON<(ForecastRecord & { lastSale?: string | null; lastPurchase?: string | null })[]>('forecast:all'),
    getJSON<{ generatedAt: string; historyMonths: number; locations: string[] }>('forecast:meta'),
  ]);

  const source = all ?? [];
  const now = meta?.generatedAt ? new Date(meta.generatedAt) : new Date();

  const records: SlowStockRecord[] = source
    .filter((r) => includeZero || r.onHand > 0 || r.onOrder > 0)
    .map((r) => {
      const history = Array.isArray(r.history) ? r.history.map((v) => Number(v) || 0) : [];
      const n = history.length;
      const sales12 = sum(history.slice(Math.max(0, n - 12)));
      const sales24 = sum(history.slice(Math.max(0, n - 24)));
      const sales36 = sum(history);
      const avgMonthly24 = sales24 / 24;

      const onHand = Number(r.onHand) || 0;
      const onOrder = Number(r.onOrder) || 0;
      const avgCost = Number(r.avgCost) || 0;
      const position = onHand + onOrder;

      // Aging: prefer Arrow's LAST_SALE (covers sales older than the 36m
      // window) when the sync provides it; otherwise read it off the series.
      const lastSale = cleanDate(r.lastSale);
      const lastPurchase = cleanDate(r.lastPurchase);
      const fromSeries = monthsSinceLastNonZero(history);
      const fromDate = lastSale ? monthsBetween(new Date(lastSale), now) : null;
      const monthsSinceLastSale = fromDate ?? fromSeries;

      // Old-sheet maths
      const coverFlat = avgMonthly24 > 0 ? r1(onHand / avgMonthly24) : null;
      const excessQty12 = Math.max(0, onHand - avgMonthly24 * 12);
      const excessQty24 = Math.max(0, onHand - avgMonthly24 * 24);

      // Seasonal maths: position vs the next 12 months of forecast
      const fc = Array.isArray(r.forecast) ? r.forecast.map((v) => Number(v) || 0) : [];
      const monthlyForecast = Number(r.monthlyForecast) || 0;
      const next12 = sum(fc.slice(0, 12)) + Math.max(0, 12 - fc.length) * monthlyForecast;
      const excessQtySeasonal12 = Math.max(0, position - next12);
      const coverSeasonal = seasonalCover(position, fc, monthlyForecast);

      const band = ageBand(monthsSinceLastSale, fromSeries);
      const buyingWhileExcess = onOrder > 0 && excessQty12 > 0;

      // Action - evaluated in order of severity.
      let act: SlowAction = 'ok';
      let reason = 'Cover within target';
      if (onHand > 0 && (monthsSinceLastSale == null || monthsSinceLastSale >= deadMonths)) {
        // Dead: nothing sold for `deadMonths` (default 24) - the old sheet's
        // "no sales in 24 months" set. Write down / clear.
        act = 'clear';
        reason = monthsSinceLastSale == null
          ? `Never sold (no sale in ${n}m window)`
          : `No sale for ${monthsSinceLastSale} months`;
      } else if (onHand > 0 && monthsSinceLastSale != null && monthsSinceLastSale >= 12) {
        act = 'stop-buying';
        reason = `Last sold ${monthsSinceLastSale} months ago`;
      } else if (coverSeasonal == null && onHand > 0) {
        act = 'stop-buying';
        reason = 'No forecast demand';
      } else if (coverSeasonal != null && coverSeasonal > slowMonths * 2) {
        act = 'stop-buying';
        reason = `${coverSeasonal} months cover incl. on order`;
      } else if (coverSeasonal != null && coverSeasonal > slowMonths) {
        act = 'review';
        reason = `${coverSeasonal} months cover incl. on order`;
      } else if (coverFlat != null && coverFlat > slowMonths) {
        // Flat average says excess, seasonal forecast says it will sell -
        // the heater-in-February case. Left as OK but the reason says why.
        reason = `Flat cover ${coverFlat}m, but seasonal demand ahead`;
      }

      return {
        sku: r.sku,
        name: r.name ?? null,
        stockCategory: r.stockCategory ?? null,
        supplierCode: r.supplierCode ?? null,
        supplierName: r.supplierName ?? null,
        supplierStock: r.supplierStock ?? null,

        onHand, onOrder,
        backordered: Number(r.backordered) || 0,
        position,
        avgCost,
        stockValue: r0(onHand * avgCost),
        positionValue: r0(position * avgCost),

        sales12: r0(sales12), sales24: r0(sales24), sales36: r0(sales36),
        avgMonthly24: Math.round(avgMonthly24 * 100) / 100,
        history,
        historyStart: r.historyStart,

        monthsSinceLastSale,
        lastSale, lastPurchase,
        ageBand: band,

        coverFlat,
        coverSeasonal,
        bucket: r.bucket,

        excessQty12: r1(excessQty12),
        excessValue12: r0(excessQty12 * avgCost),
        excessQty24: r1(excessQty24),
        excessValue24: r0(excessQty24 * avgCost),
        excessQtySeasonal12: r1(excessQtySeasonal12),
        excessValueSeasonal12: r0(excessQtySeasonal12 * avgCost),

        buyingWhileExcess,
        action: act,
        reason,
      };
    });

  const suppliers = [...new Set(records.map((r) => r.supplierName).filter(Boolean) as string[])].sort();
  const categories = [...new Set(records.map((r) => r.stockCategory).filter(Boolean) as string[])].sort();

  const filtered = records.filter((r) => {
    if (supplier && r.supplierName !== supplier) return false;
    if (category && r.stockCategory !== category) return false;
    if (action && r.action !== action) return false;
    if (age && r.ageBand !== age) return false;
    if (q && !(r.sku.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q) || (r.supplierStock || '').toUpperCase().includes(q))) return false;
    return true;
  });

  // Biggest problem first.
  filtered.sort((a, b) => b.excessValue12 - a.excessValue12 || b.stockValue - a.stockValue);

  // --- summary over the filtered set, so the cards always match the table ---
  const onHandRecs = filtered.filter((r) => r.onHand > 0);
  const dead = onHandRecs.filter((r) => r.action === 'clear');
  const bwe = filtered.filter((r) => r.buyingWhileExcess);

  const byAction = { clear: z(), 'stop-buying': z(), review: z(), ok: z() } as SlowStockResponse['summary']['byAction'];
  const byAge = { '<12m': z(), '12-24m': z(), '24-36m': z(), '36m+': z() } as SlowStockResponse['summary']['byAge'];
  for (const r of onHandRecs) {
    byAction[r.action].skus++; byAction[r.action].stockValue += r.stockValue;
    byAge[r.ageBand].skus++;   byAge[r.ageBand].stockValue += r.stockValue;
  }

  const supMap = new Map<string, SupplierSummary>();
  for (const r of filtered) {
    const key = r.supplierName || r.supplierCode || 'Unknown';
    if (!supMap.has(key)) {
      supMap.set(key, { supplierName: key, supplierCode: r.supplierCode, skus: 0, stockValue: 0, excessValue12: 0, deadValue: 0, onOrderValue: 0 });
    }
    const s = supMap.get(key)!;
    if (r.onHand > 0) s.skus++;
    s.stockValue += r.stockValue;
    s.excessValue12 += r.excessValue12;
    if (r.action === 'clear') s.deadValue += r.stockValue;
    s.onOrderValue += r0(r.onOrder * r.avgCost);
  }
  const bySupplier = [...supMap.values()].sort((a, b) => b.excessValue12 - a.excessValue12);

  // Concentration: how many SKUs carry half / 80% of the 12m excess value.
  const exVals = filtered.map((r) => r.excessValue12).filter((v) => v > 0).sort((a, b) => b - a);
  const exTotal = sum(exVals);
  const countTo = (pct: number) => {
    let acc = 0;
    for (let i = 0; i < exVals.length; i++) {
      acc += exVals[i];
      if (acc >= exTotal * pct) return i + 1;
    }
    return exVals.length;
  };

  const body: SlowStockResponse = {
    records: filtered,
    suppliers,
    categories,
    meta: meta ?? null,
    thresholds: { slowMonths, deadMonths },
    summary: {
      skusOnHand: onHandRecs.length,
      stockValue: sum(onHandRecs.map((r) => r.stockValue)),
      excessValue12: sum(filtered.map((r) => r.excessValue12)),
      excessValue24: sum(filtered.map((r) => r.excessValue24)),
      excessValueSeasonal12: sum(filtered.map((r) => r.excessValueSeasonal12)),
      deadSkus: dead.length,
      deadValue: sum(dead.map((r) => r.stockValue)),
      buyingWhileExcessSkus: bwe.length,
      buyingWhileExcessValue: sum(bwe.map((r) => r0(r.onOrder * r.avgCost))),
      skusTo50pct: exTotal > 0 ? countTo(0.5) : 0,
      skusTo80pct: exTotal > 0 ? countTo(0.8) : 0,
      byAction,
      byAge,
      bySupplier,
    },
  };
  return NextResponse.json(body);
}

function z() {
  return { skus: 0, stockValue: 0 };
}
