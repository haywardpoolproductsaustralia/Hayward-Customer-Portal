import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess, resolvePriceType } from '@/lib/access';
import { getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, PricingRule } from '@/lib/pricing';

interface BatchItem {
  sku: string;
  stockCategory?: string | null;
  listPrice?: number | null;
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
    return NextResponse.json(
      { error: 'Provide items: [{ sku, stockCategory, listPrice }]' },
      { status: 400 }
    );
  }

  const requestedCode = typeof body?.customerCode === 'string' ? body.customerCode.trim() : null;
  const { representativeCode, priceType } = await resolvePriceType(access, requestedCode);
  if (!representativeCode) {
    return NextResponse.json({ error: 'No customer code resolved for pricing' }, { status: 404 });
  }
  if (!priceType) {
    return NextResponse.json({ error: 'No price type found for this customer' }, { status: 404 });
  }

  // One rules fetch, reused for every item in the batch.
  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];

  const results = items.map(({ sku, stockCategory, listPrice }) => {
    const rule = findRuleForSku(rules, sku, stockCategory);
    if (!rule) {
      return { sku, listPrice: listPrice ?? null, price: null, discountPercent: null };
    }
    const resolvedListPrice = listPrice ?? null;
    const price = computePrice(rule, qty, resolvedListPrice);
    return {
      sku,
      listPrice: resolvedListPrice,
      price,
      discountPercent:
        resolvedListPrice && price != null
          ? Math.round((1 - price / resolvedListPrice) * 1000) / 10
          : null,
    };
  });

  return NextResponse.json({ priceType, qty, results });
}
