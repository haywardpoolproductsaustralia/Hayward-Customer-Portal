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
 * Computes a final price for a quantity, using the same logic as the
 * existing Pricing Tool: the highest quantity-break threshold the qty
 * meets or exceeds wins; if none match, fall back to the flat discount,
 * then to the lowest tier's discount as a last resort.
 */
export function computePrice(rule: PricingRule, qty: number): number | null {
  if (rule.listPrice == null) return null;

  const sortedBreaks = [...rule.breaks].sort((a, b) => a.qty - b.qty);

  let bestDiscount: number | null = null;
  for (const b of sortedBreaks) {
    if (qty >= b.qty) bestDiscount = b.discount;
  }

  if (bestDiscount != null) {
    return round2(rule.listPrice * (1 - bestDiscount / 100));
  }
  if (rule.priceDiscount) {
    return round2(rule.listPrice * (1 - rule.priceDiscount / 100));
  }
  if (sortedBreaks.length > 0) {
    return round2(rule.listPrice * (1 - sortedBreaks[0].discount / 100));
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
