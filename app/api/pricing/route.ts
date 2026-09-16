import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess, resolvePriceType, stockKeysForSku } from '@/lib/access';
import { getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, getListPrice, PricingRule } from '@/lib/pricing';

interface StockEntryLite {
  stockCategory?: string | null;
  listPrice?: number | null;
}

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const sku = searchParams.get('sku')?.trim();
  const qty = Number(searchParams.get('qty') ?? '1') || 1;

  if (!sku) {
    return NextResponse.json({ error: 'Provide a sku query parameter' }, { status: 400 });
  }

  const requestedCode = searchParams.get('customerCode')?.trim() || null;
  const { representativeCode, priceType } = await resolvePriceType(access, requestedCode);
  if (!representativeCode) {
    return NextResponse.json({ error: 'No customer code resolved for pricing' }, { status: 404 });
  }
  if (!priceType) {
    return NextResponse.json({ error: 'No price type found for this customer' }, { status: 404 });
  }

  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];

  // The stock entry carries BOTH the category (for category-fallback rules) and
  // STKMAST.SELLING_PRICE1 as `listPrice`.
  //
  // Probe only the catalogues this org holds, matching /api/stock. The previous
  // hard-coded `stock:{sku}` meant Paramount and Flow Control SKUs never found
  // an entry here even for orgs entitled to them.
  let stockEntry: StockEntryLite | null = null;
  for (const key of stockKeysForSku(access, sku)) {
    stockEntry = await getJSON<StockEntryLite>(key);
    if (stockEntry) break;
  }

  // List price resolution, most to least authoritative:
  //   1. pricing:listprices     - the refreshed list published by the pricing sync
  //   2. stock:{sku}.listPrice  - STKMAST.SELLING_PRICE1, written every stock sync
  //   3. rule.listPrice         - the SKU's own price embedded in its rule
  //
  // Step 2 is the fix for the product modal showing "On request" while the grid
  // beside it showed a price: /api/pricing/batch is HANDED listPrice by the
  // products page (which reads it off the stock entry), whereas this route only
  // ever looked at pricing:listprices. Whenever that key was missing or stale,
  // computePrice() got a null base and returned null, so the modal rendered
  // "On request" with no error - the same SKU priced fine in the grid.
  // Reading the stock entry here makes both paths agree by construction.
  let listPrice = await getListPrice(sku);
  if (listPrice == null && stockEntry?.listPrice != null) {
    listPrice = stockEntry.listPrice;
  }

  const rule = findRuleForSku(rules, sku, stockEntry?.stockCategory);

  if (!rule) {
    return NextResponse.json(
      { error: 'No specific pricing rule found for this SKU yet' },
      { status: 404 }
    );
  }

  if (listPrice == null && rule.listPrice != null) {
    listPrice = rule.listPrice;
  }

  const price = computePrice(rule, qty, listPrice);

  // Full quantity-break ladder, so the UI can show "buy 3+, buy 11+, ..."
  // instead of just one number for the requested qty.
  const breaks = [...rule.breaks]
    .sort((a, b) => a.qty - b.qty)
    .map((b) => ({ qty: b.qty, price: computePrice(rule, b.qty, listPrice) }));

  return NextResponse.json({
    sku,
    qty,
    priceType,
    listPrice,
    price,
    discountPercent:
      listPrice && price != null ? Math.round((1 - price / listPrice) * 1000) / 10 : null,
    breaks,
  });
}
