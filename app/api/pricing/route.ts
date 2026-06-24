import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { redis, getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, PricingRule } from '@/lib/pricing';

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

  const representativeCode = access.branchCode ?? access.customerCodes[0];
  if (!representativeCode) {
    return NextResponse.json({ error: 'No customer code resolved for pricing' }, { status: 404 });
  }

  // customerPriceType:{code} is a raw string, not JSON - read directly.
  const priceType = await redis.get<string>(`customerPriceType:${representativeCode}`);
  if (!priceType) {
    return NextResponse.json({ error: 'No price type found for this customer' }, { status: 404 });
  }

  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];

  // The SKU's own list price and category - needed for category-fallback
  // pricing, since category rules have no list price of their own.
  const stockEntry = await getJSON<{ stockCategory: string | null; listPrice: number | null }>(
    `stock:${sku}`
  );
  const rule = findRuleForSku(rules, sku, stockEntry?.stockCategory);

  if (!rule) {
    return NextResponse.json(
      { error: 'No specific pricing rule found for this SKU yet' },
      { status: 404 }
    );
  }

  const listPrice = stockEntry?.listPrice ?? null;
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
