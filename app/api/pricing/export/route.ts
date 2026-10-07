import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import {
  getCustomerAccess,
  resolvePriceType,
  canSeeCatalogue,
  STOCK_ALL_KEY,
  PARAMOUNT_CATEGORY,
  FLOW_CONTROL_SUPPLIER_CODES,
} from '@/lib/access';
import { getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, getCustomerRules, PricingRule } from '@/lib/pricing';

// ---------------------------------------------------------------------------
// GET /api/pricing/export[?customerCode=XXXXXX]
//
// Downloads the caller's full price list as .xlsx - every SKU in every
// catalogue their org holds, priced with exactly the same resolution as
// /api/pricing (findRuleForSku + computePrice, same list-price precedence),
// so the spreadsheet and the screen agree by construction.
//
// Built server-side on purpose: the browser only ever receives finished
// prices, never the pricing:{type} rule set, and it's one request instead of
// ~100 batch calls.
//
// Scope:
//   - Hayward SKUs only, for everyone - EXCEPT accounts in Poolwater Products
//     and Compass, whose export also includes Paramount. Flow Control is never
//     exported. Decided on the group of the account being PRICED (so staff
//     exporting "as" a PWP/Compass account get Paramount, and staff exporting
//     as anyone else don't), and still intersected with the caller's own
//     catalogue permission, so this can only ever narrow access, never widen.
//   - Every row is re-checked against STOCK_CATEGORY / SUPPLIER_CODE, so a
//     PR or 17300 SKU that slips into stock:all is still left out.
//   - customerCode is honoured only if it's inside access.customerCodes
//     (resolvePriceType enforces that).
//   - Hayward staff (aggregate org) MUST pass customerCode. Without it,
//     resolvePriceType would fall back to customerCodes[0] - an arbitrary
//     account - and staff could send a customer someone else's prices.
// ---------------------------------------------------------------------------

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  supplierCode?: string | null;
  listPrice?: number | null;
}

/** Groups (lib/access.ts groupKey) whose price list export includes Paramount. */
const PARAMOUNT_EXPORT_GROUPS: ReadonlySet<string> = new Set(['PoolwaterProducts', 'Compass']);

function isParamount(e: StockEntry): boolean {
  return str(e.stockCategory).toUpperCase() === PARAMOUNT_CATEGORY;
}

function isFlowControl(e: StockEntry): boolean {
  return FLOW_CONTROL_SUPPLIER_CODES.has(str(e.supplierCode));
}

const GST_RATE = 0.1;
const MONEY = '"$"#,##0.00';
const PCT = '0.0"%"';

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** "2026-10-08" in Melbourne time, for the filename and the sheet header. */
function melbDate(): { iso: string; long: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const long = now.toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return { iso: parts, long };
}

/**
 * Turns a rule into displayable tiers: [{ fromQty, price }], first tier always
 * fromQty 1. Arrow thresholds are UPPER bounds, so tier i starts at
 * (threshold[i-1] + 1). Flat (BREAK_FLAG='N') rules and ladders whose steps
 * don't change the price collapse to a single tier.
 */
function tiersFor(rule: PricingRule, listPrice: number | null): { fromQty: number; price: number }[] {
  const base = computePrice(rule, 1, listPrice);
  if (base == null) return [];

  const flat = str(rule.breakFlag).toUpperCase() === 'N';
  const sorted = flat
    ? []
    : [...(rule.breaks ?? [])].filter((b) => b.qty > 0).sort((a, b) => a.qty - b.qty);

  const tiers: { fromQty: number; price: number }[] = [{ fromQty: 1, price: base }];
  for (let i = 1; i < sorted.length; i++) {
    const fromQty = sorted[i - 1].qty + 1;
    const price = computePrice(rule, fromQty, listPrice);
    if (price == null) continue;
    if (price === tiers[tiers.length - 1].price) continue; // no actual saving - don't show a fake break
    tiers.push({ fromQty, price });
  }
  return tiers;
}

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const requestedCode = searchParams.get('customerCode')?.trim() || null;

  if (access.isAggregate && !requestedCode) {
    return NextResponse.json(
      { error: 'Select a customer in "Pricing as" before downloading a price list.' },
      { status: 400 }
    );
  }

  const { representativeCode, priceType } = await resolvePriceType(access, requestedCode);
  if (!representativeCode) {
    return NextResponse.json({ error: 'No customer code resolved for pricing' }, { status: 404 });
  }
  if (!priceType) {
    return NextResponse.json({ error: 'No price type found for this customer' }, { status: 404 });
  }

  // Which catalogues go in the file - see the Scope note at the top.
  const codeToGroup = await getJSON<Record<string, string>>('codeToGroup');
  const pricedGroup = str(codeToGroup?.[representativeCode]) || access.groupKey;
  const includeParamount =
    PARAMOUNT_EXPORT_GROUPS.has(pricedGroup) && canSeeCatalogue(access, 'paramount');

  const sources: { key: string; keep: (e: StockEntry) => boolean }[] = [
    { key: STOCK_ALL_KEY.hayward, keep: (e) => !isParamount(e) && !isFlowControl(e) },
  ];
  if (includeParamount) {
    sources.push({ key: STOCK_ALL_KEY.paramount, keep: (e) => isParamount(e) && !isFlowControl(e) });
  }

  const [lists, listPrices, rulesRaw, customerRules, customerNames] = await Promise.all([
    Promise.all(sources.map((src) => getJSON<StockEntry[]>(src.key))),
    getJSON<Record<string, number>>('pricing:listprices'),
    getJSON<PricingRule[]>(`pricing:${priceType}`),
    getCustomerRules(representativeCode),
    getJSON<Record<string, string>>('customerNames'),
  ]);
  const rules = Array.isArray(rulesRaw) ? rulesRaw : [];

  // De-dupe across catalogues (first one wins - Hayward is pinned first).
  const seen = new Set<string>();
  const stock: StockEntry[] = [];
  lists.forEach((list, i) => {
    for (const e of Array.isArray(list) ? list : []) {
      const sku = str(e?.sku);
      if (!sku || seen.has(sku) || !sources[i].keep(e)) continue;
      seen.add(sku);
      stock.push({ ...e, sku });
    }
  });
  stock.sort((a, b) => a.sku.localeCompare(b.sku));

  // --- price every SKU ----------------------------------------------------
  type Row = {
    sku: string;
    name: string;
    listPrice: number | null;
    discount: number | null;
    price: number | null;
    tiers: { fromQty: number; price: number }[];
  };

  const rows: Row[] = stock.map((e) => {
    const rule = findRuleForSku(rules, e.sku, e.stockCategory, customerRules);

    // Same precedence as /api/pricing: pricing:listprices -> stock entry -> rule.
    let listPrice: number | null =
      listPrices && e.sku in listPrices ? Number(listPrices[e.sku]) : null;
    if (listPrice == null || Number.isNaN(listPrice)) {
      listPrice = e.listPrice != null ? Number(e.listPrice) : null;
    }
    if ((listPrice == null || Number.isNaN(listPrice)) && rule?.listPrice != null) {
      listPrice = Number(rule.listPrice);
    }
    if (listPrice != null && (Number.isNaN(listPrice) || listPrice <= 0)) listPrice = null;

    const tiers = rule ? tiersFor(rule, listPrice) : [];
    const price = tiers[0]?.price ?? null;
    const discount =
      listPrice && price != null ? Math.round((1 - price / listPrice) * 1000) / 10 : null;

    return { sku: e.sku, name: str(e.name), listPrice, discount, price, tiers };
  });

  const maxExtraTiers = rows.reduce((m, r) => Math.max(m, r.tiers.length - 1), 0);
  const pricedCount = rows.filter((r) => r.price != null).length;

  // --- build the sheet ----------------------------------------------------
  const accountName = str(customerNames?.[representativeCode]) || access.groupName;
  const accountLabel =
    !access.isAggregate && access.isHeadOffice && !requestedCode
      ? `${access.groupName} (group pricing)`
      : `${accountName} (${representativeCode})`;
  const { iso, long } = melbDate();

  const header = [
    'SKU',
    'Description',
    'List price (ex GST)',
    'Your discount',
    'Your price (ex GST)',
    'Your price (inc GST)',
  ];
  for (let i = 1; i <= maxExtraTiers; i++) {
    header.push(`Break ${i} - from qty`, `Break ${i} - price (ex GST)`);
  }
  header.push('Notes');

  const aoa: (string | number | null)[][] = [
    ['Hayward Pool Products Australia - Price List'],
    [`Account: ${accountLabel}`],
    [`Generated: ${long} (Melbourne)`],
    [
      'All prices in AUD. "Your price" is per unit at qty 1; quantity breaks to the right apply per line. ' +
        'Prices are a guide as at the date above and are confirmed at order.',
    ],
    [],
    header,
  ];
  const HEADER_ROW = aoa.length - 1; // 0-based index of the column header row

  for (const r of rows) {
    const line: (string | number | null)[] = [
      r.sku,
      r.name,
      r.listPrice,
      r.discount,
      r.price,
      r.price != null ? round2(r.price * (1 + GST_RATE)) : null,
    ];
    for (let i = 1; i <= maxExtraTiers; i++) {
      const t = r.tiers[i];
      line.push(t ? t.fromQty : null, t ? t.price : null);
    }
    line.push(r.price == null ? 'Price on request' : '');
    aoa.push(line);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Number formats on the data cells (rows after the header).
  const moneyCols = [2, 4, 5];
  for (let i = 1; i <= maxExtraTiers; i++) moneyCols.push(6 + i * 2 - 1);
  for (let r = HEADER_ROW + 1; r < aoa.length; r++) {
    for (const c of moneyCols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') cell.z = MONEY;
    }
    const pct = ws[XLSX.utils.encode_cell({ r, c: 3 })];
    if (pct && pct.t === 'n') pct.z = PCT;
  }

  const lastCol = header.length - 1;
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: HEADER_ROW, c: 0 }, e: { r: aoa.length - 1, c: lastCol } }),
  };
  ws['!cols'] = header.map((h, i) =>
    i === 0 ? { wch: 20 } : i === 1 ? { wch: 48 } : i === lastCol ? { wch: 18 } : { wch: Math.max(14, h.length + 2) }
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Price list');
  wb.Props = {
    Title: 'Hayward Price List',
    Author: 'Hayward Pool Products Australia',
    Company: 'Hayward Pool Products Australia',
  };

  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });

  const safeCode = representativeCode.replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `Hayward-Price-List-${safeCode}-${iso}.xlsx`;

  // Uint8Array rather than Buffer: newer @types/node Buffer typings don't
  // satisfy BodyInit under TS 5.7+.
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Price-List-Rows': String(rows.length),
      'X-Price-List-Priced': String(pricedCount),
    },
  });
}
