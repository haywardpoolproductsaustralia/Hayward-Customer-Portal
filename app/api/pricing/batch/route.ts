import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { redis, getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, PricingRule } from '@/lib/pricing';

interface BatchItem {
  sku: string;
  stockCategory?: string | null;
}

export async function POST(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const items: BatchItem[] = Array.isArray(body?.items) ? body.items : [];
  const qty = Number(body?.qty ?? 1) || 1;

  if (items.length === 0) {
    return NextResponse.json({ error: 'Provide items: [{ sku, stockCategory }]' }, { status: 400 });
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

  // One rules fetch, reused for every item in the batch.
  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];

  const results = items.map(({ sku, stockCategory }) => {
    const rule = findRuleForSku(rules, sku, stockCategory);
    if (!rule) {
      return { sku, listPrice: null, price: null, discountPercent: null };
    }
    const price = computePrice(rule, qty);
    return {
      sku,
      listPrice: rule.listPrice,
      price,
      discountPercent:
        rule.listPrice && price != null
          ? Math.round((1 - price / rule.listPrice) * 1000) / 10
          : null,
    };
  });

  return NextResponse.json({ priceType, qty, results });
}
