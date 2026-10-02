import { getJSON } from '@/lib/redis';

export interface PricingRule {
  sku: string;
  stockCategory: string;
  subCategory: string;
  priceDiscount: number;
  breakFlag: string;
  breaks: { qty: number; discount: number }[];
  listPrice: number | null;
  validFrom: string;
  validTo: string;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Get the list price for a SKU from the new pricing:listprices cache.
 * This reads from the updated STKMAST.SELLING_PRICE1 written by sync-list-prices.js.
 * Falls back to null if the SKU is not found.
 * 
 * FIX (Sep 10, 2026): Changed to match the flat object format that load-complete-pricing.js
 * actually stores, rather than expecting a nested { listPrice: ... } structure.
 */
export async function getListPrice(sku: string): Promise<number | null> {
  try {
    const prices = await getJSON<Record<string, number>>(
      'pricing:listprices'
    );
    if (!prices || !(sku in prices)) {
      return null;
    }
    return prices[sku] ?? null;  // Direct access to flat object
  } catch {
    return null;
  }
}

/**
 * Computes a final price for a quantity, matching Arrow exactly.
 *
 * Arrow's SPRTRAN QUANTITY_n values are UPPER bounds ("up to"):
 *   QUANTITY_1=5  PRICE_DISC_1=69   -> qty 1-5    gets 69%
 *   QUANTITY_2=1000 PRICE_DISC_2=71 -> qty 6-1000 gets 71%
 * So the applicable tier is the LOWEST threshold the qty is <= to.
 * (Fixed 2 Oct 2026: this previously took the highest threshold <= qty,
 * which is one tier short at every break boundary - e.g. qty 6 got 69%
 * instead of 71%, qty 40 got 71.5% instead of 73.5% - and is what raised
 * the "price differs" flag on portal orders. app/dashboard/pricing/page.tsx
 * resolvePrice() already used the correct upper-bound rule.)
 *
 * Qty above the last threshold uses the last tier. No breaks at all ->
 * the flat PRICE_DISCOUNT.
 *
 * `listPrice` is passed in explicitly (the SKU's own STKMAST.SELLING_PRICE1)
 * rather than read from `rule.listPrice` - category-level rules have no SKU
 * of their own in SPRTRAN, so their `listPrice` is always null.
 */
export function computePrice(rule: PricingRule, qty: number, listPrice: number | null): number | null {
  if (listPrice == null) return null;

  const sortedBreaks = [...(rule.breaks ?? [])]
    .filter((b) => b.qty > 0)
    .sort((a, b) => a.qty - b.qty);

  if (sortedBreaks.length > 0) {
    const tier = sortedBreaks.find((b) => qty <= b.qty) ?? sortedBreaks[sortedBreaks.length - 1];
    return round2(listPrice * (1 - tier.discount / 100));
  }
  if (rule.priceDiscount) {
    return round2(listPrice * (1 - rule.priceDiscount / 100));
  }
  return null;
}

/**
 * Finds the pricing rule for a specific SKU within a price type's rule
 * set: an exact SKU match first, falling back to a category-level rule
 * (where the rule's own `sku` is blank but its `stockCategory` matches)
 * if the SKU has no rule of its own.
 */
export function findRuleForSku(
  rules: PricingRule[],
  sku: string,
  stockCategory?: string | null
): PricingRule | null {
  const exact = rules.find((r) => r.sku === sku);
  if (exact) return exact;
  if (stockCategory) {
    const categoryMatch = rules.find((r) => r.sku === '' && r.stockCategory === stockCategory);
    if (categoryMatch) return categoryMatch;
  }
  return null;
}
