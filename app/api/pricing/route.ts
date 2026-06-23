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

  // Pricing is resolved by price type (AUTO_PRICE_TYPE), not by individual
  // customer code. For a branch login, use that branch's own price type.
  // For head office, use the group's first customer code as the
  // representative price - this assumes every branch in the group shares
  // one price type. If a group ever turns out to have branches on
  // genuinely different negotiated rates, this will need revisiting.
  const representativeCode = access.branchCode ?? access.customerCodes[0];
  if (!representativeCode) {
    return NextResponse.json({ error: 'No customer code resolved for pricing' }, { status: 404 });
  }

  // NOTE: customerPriceType:{code} is stored as a raw string by the sync
  // job (not JSON.stringify'd), so it's read directly via redis.get rather
  // than the getJSON helper.
  const priceType = await redis.get<string>(`customerPriceType:${representativeCode}`);
  if (!priceType) {
    return NextResponse.json({ error: 'No price type found for this customer' }, { status: 404 });
  }

  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];

  // Needed for category-fallback pricing when the SKU has no rule of its own.
  const stockEntry = await getJSON<{ stockCategory: string | null }>(`stock:${sku}`);
  const rule = findRuleForSku(rules, sku, stockEntry?.stockCategory);

  if (!rule) {
    return NextResponse.json(
      { error: 'No specific pricing rule found for this SKU yet' },
      { status: 404 }
    );
  }

  const price = computePrice(rule, qty);

  return NextResponse.json({
    sku,
    qty,
    priceType,
    listPrice: rule.listPrice,
    price,
    discountPercent:
      rule.listPrice && price != null
        ? Math.round((1 - price / rule.listPrice) * 1000) / 10
        : null,
  });
}
