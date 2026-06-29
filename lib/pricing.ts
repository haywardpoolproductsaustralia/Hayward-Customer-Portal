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
 * Computes a final price for a quantity using Arrow's actual break logic.
 *
 * Arrow's SPRTRAN thresholds are UPPER bounds, not lower bounds:
 * QUANTITY_1=3, DISC_1=70% means "qty 1–3 gets 70% off"
 * QUANTITY_2=11, DISC_2=72% means "qty 4–11 gets 72% off"
 * QUANTITY_3=1000, DISC_3=74% means "qty 12–1000 gets 74% off"
 *
 * So the correct selection is: find the LOWEST threshold that is >= qty.
 * That threshold's discount is the one that applies.
 * If qty exceeds ALL thresholds, use the last (highest) tier's discount.
 *
 * `listPrice` is passed in explicitly (the SKU's own STKMAST.SELLING_PRICE1)
 * rather than read from `rule.listPrice` - category-level rules have no SKU
 * of their own, so their listPrice is always null.
 */
export function computePrice(rule: PricingRule, qty: number, listPrice: number | null): number | null {
  if (listPrice == null) return null;

  const sortedBreaks = [...rule.breaks].sort((a, b) => a.qty - b.qty);
  if (sortedBreaks.length === 0) return null;

  // Find the lowest threshold >= qty (Arrow upper-bound logic)
  const applicableTier = sortedBreaks.find((b) => qty <= b.qty);

  // If qty exceeds all thresholds, use the last tier
  const discount = applicableTier
    ? applicableTier.discount
    : sortedBreaks[sortedBreaks.length - 1].discount;

  return round2(listPrice * (1 - discount / 100));
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
