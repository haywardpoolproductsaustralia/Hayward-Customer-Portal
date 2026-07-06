'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Trash2, Loader2, Printer, FileText, TrendingUp } from 'lucide-react';
import { ProductCombobox } from '@/components/ProductCombobox';
import { useSelectedCustomer } from '@/components/SelectedCustomerContext';

interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  supplierStock?: string | null;
}

interface PriceTier {
  qty: number;
  price: number | null;
}

interface QuoteLine {
  sku: string;
  name: string;
  qty: number;
  listPrice: number | null;
  tiers: PriceTier[]; // sorted ascending by qty, qty:1 baseline included
  loading: boolean;
  error: string | null;
}

function formatMoney(value: number | null) {
  if (value == null) return '-';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

// Arrow's SPRTRAN thresholds are UPPER bounds:
// qty=3, disc=70% means "qty 1–3 gets 70% off".
// So we find the LOWEST threshold >= qty to get the applicable tier.
function resolvePrice(tiers: PriceTier[], qty: number): number | null {
  const sorted = [...tiers].sort((a, b) => a.qty - b.qty);
  const tier = sorted.find((t) => qty <= t.qty);
  if (tier) return tier.price;
  // qty exceeds all thresholds — use last tier
  return sorted.length > 0 ? sorted[sorted.length - 1].price : null;
}

// Label for a tier given its index in the sorted array.
// e.g. [{qty:3}, {qty:11}, {qty:1000}] →  "1–3", "4–11", "12+"
function tierLabel(sorted: PriceTier[], index: number): string {
  const lower = index === 0 ? 1 : sorted[index - 1].qty + 1;
  const isLast = index === sorted.length - 1;
  if (isLast) return `${lower}+`;
  return `${lower}–${sorted[index].qty}`;
}

interface TierSuggestion {
  extraUnits: number;
  newQty: number;
  newUnitPrice: number;
  savingsPerUnit: number;
  newLineTotal: number;
}

// Finds the next cheaper tier and how many units to add to reach it.
function getNextTierSuggestion(tiers: PriceTier[], qty: number, currentUnitPrice: number | null): TierSuggestion | null {
  if (currentUnitPrice == null) return null;
  const sorted = [...tiers].sort((a, b) => a.qty - b.qty);
  const currentIndex = sorted.findIndex((t) => qty <= t.qty);
  // If we're at the last tier or beyond all tiers, no suggestion
  if (currentIndex === -1 || currentIndex === sorted.length - 1) return null;
  const nextTier = sorted[currentIndex + 1];
  if (nextTier.price == null || nextTier.price >= currentUnitPrice) return null;
  // Next tier starts one unit above the current tier's upper bound
  const nextLowerBound = sorted[currentIndex].qty + 1;
  const extraUnits = nextLowerBound - qty;
  return {
    extraUnits,
    newQty: nextLowerBound,
    newUnitPrice: nextTier.price,
    savingsPerUnit: currentUnitPrice - nextTier.price,
    newLineTotal: nextTier.price * nextLowerBound,
  };
}

export default function PricingPage() {
  const [allStock, setAllStock] = useState<StockEntry[]>([]);
  const [stockLoading, setStockLoading] = useState(true);
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const { selectedCustomer } = useSelectedCustomer();

  // Always-current view of `lines` so the re-price effect below reads the
  // latest list (incl. a just-added line) rather than a render-time snapshot.
  const linesRef = useRef<QuoteLine[]>([]);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stock')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setAllStock(data.results ?? []);
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-price every line already on the quote whenever the selected
  // customer changes (picked from the header, not a page-local control) -
  // prices shown before the switch are for a different customer and
  // would otherwise look right while being wrong.
  useEffect(() => {
    const current = linesRef.current;
    if (current.length === 0) return;
    setLines((prev) => prev.map((l) => ({ ...l, loading: true, error: null })));
    current.forEach((l) => refetchLine(l.sku, l.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.code]);

  function pricingUrl(sku: string, qty: number) {
    const params = new URLSearchParams({ sku, qty: String(qty) });
    if (selectedCustomer) params.set('customerCode', selectedCustomer.code);
    return `/api/pricing?${params.toString()}`;
  }

  async function refetchLine(sku: string, name: string) {
    try {
      const res = await fetch(pricingUrl(sku, 1));
      const data = await res.json();
      setLines((prev) =>
        prev.map((l) =>
          l.sku !== sku
            ? l
            : !res.ok
              ? { ...l, loading: false, error: data.error ?? 'No price found' }
              : {
                  ...l,
                  loading: false,
                  listPrice: data.listPrice,
                  tiers:
                    ((data.breaks ?? []) as PriceTier[]).length > 0
                      ? [...((data.breaks ?? []) as PriceTier[])].sort((a, b) => a.qty - b.qty)
                      : [{ qty: 1, price: data.price }],
                }
        )
      );
    } catch {
      setLines((prev) =>
        prev.map((l) => (l.sku !== sku ? l : { ...l, loading: false, error: 'Could not reach pricing' }))
      );
    }
  }

  async function addToQuote(item: StockEntry) {
    const newLine: QuoteLine = {
      sku: item.sku,
      name: item.name || item.sku,
      qty: 1,
      listPrice: null,
      tiers: [],
      loading: true,
      error: null,
    };
    setLines((prev) => [...prev, newLine]);
    await refetchLine(item.sku, newLine.name);
  }

  function updateQty(sku: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.sku === sku ? { ...l, qty: Math.max(1, qty) } : l)));
  }

  function removeLine(sku: string) {
    setLines((prev) => prev.filter((l) => l.sku !== sku));
  }

  const grandTotal = lines.reduce((sum, l) => {
    const price = resolvePrice(l.tiers, l.qty);
    return sum + (price ?? 0) * l.qty;
  }, 0);

  const addedSkus = new Set<string>(lines.map((l) => l.sku));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">Quote builder</h1>
          <p className="text-ink/50 mt-1">Add products, set quantities, get your discounted price per line.</p>
        </div>
        {lines.length > 0 && (
          <button
            onClick={() => window.print()}
            className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2"
          >
            <Printer className="h-4 w-4" /> Print quote
          </button>
        )}
      </div>

      {selectedCustomer && (
        <div className="rounded-xl bg-wave/5 border border-wave/20 px-4 py-2.5 text-sm text-deep">
          Showing pricing for <span className="font-semibold">{selectedCustomer.name}</span> - change this from the
          picker in the top bar.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Find by SKU</label>
          <ProductCombobox
            mode="sku"
            options={allStock}
            excludeSkus={addedSkus}
            disabled={stockLoading}
            onSelect={addToQuote}
            placeholder={stockLoading ? 'Loading products…' : 'Type a SKU or supplier code'}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Find by description</label>
          <ProductCombobox
            mode="description"
            options={allStock}
            excludeSkus={addedSkus}
            disabled={stockLoading}
            onSelect={addToQuote}
            placeholder={stockLoading ? 'Loading products…' : 'Type a product description'}
          />
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <FileText className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">Search above and add products to start a quote.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-ink/40">
                <th className="px-5 py-3.5 font-medium">Product</th>
                <th className="px-5 py-3.5 font-medium text-right">Qty</th>
                <th className="px-5 py-3.5 font-medium text-right">List price</th>
                <th className="px-5 py-3.5 font-medium text-right">Unit price</th>
                <th className="px-5 py-3.5 font-medium text-right">Line total</th>
                <th className="px-5 py-3.5 font-medium print:hidden"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const unitPrice = resolvePrice(l.tiers, l.qty);
                const discountPercent =
                  l.listPrice && unitPrice != null
                    ? Math.round((1 - unitPrice / l.listPrice) * 1000) / 10
                    : null;
                const suggestion = getNextTierSuggestion(l.tiers, l.qty, unitPrice);
                const sortedTiers = [...l.tiers].sort((a, b) => a.qty - b.qty);

                return (
                  <Fragment key={l.sku}>
                    <tr className="border-b border-ink/5">
                      <td className="px-5 py-3.5">
                        <p className="font-medium text-ink">{l.name}</p>
                        <p className="text-xs text-ink/40 font-mono">{l.sku}</p>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <input
                          type="number"
                          min="1"
                          value={l.qty}
                          onChange={(e) => updateQty(l.sku, Number(e.target.value) || 1)}
                          className="w-20 rounded-lg border border-ink/10 px-2 py-1 text-right text-sm focus:border-wave outline-none print:border-none"
                        />
                      </td>
                      <td className="px-5 py-3.5 text-right text-ink/50">
                        {l.loading || l.error ? '-' : formatMoney(l.listPrice)}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {l.loading ? (
                          <Loader2 className="h-4 w-4 animate-spin inline text-ink/30" />
                        ) : l.error ? (
                          <span className="text-xs text-amber">{l.error}</span>
                        ) : (
                          <div>
                            <div>{formatMoney(unitPrice)}</div>
                            {discountPercent ? (
                              <div className="text-xs font-semibold text-sunset">-{discountPercent}% off list</div>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right font-semibold text-deep">
                        {!l.loading && !l.error ? formatMoney((unitPrice ?? 0) * l.qty) : '-'}
                      </td>
                      <td className="px-5 py-3.5 text-right print:hidden">
                        <button onClick={() => removeLine(l.sku)} className="p-1.5 rounded-full hover:bg-coral/10">
                          <Trash2 className="h-4 w-4 text-ink/30 hover:text-coral" />
                        </button>
                      </td>
                    </tr>
                    {!l.loading && !l.error && sortedTiers.length > 0 && (
                      <tr className="border-b border-ink/5 last:border-0 print:hidden">
                        <td colSpan={6} className="px-5 pb-3.5 pt-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-ink/40">Quantity breaks:</span>
                            {sortedTiers.map((t, idx) => {
                              const lowerBound = idx === 0 ? 1 : sortedTiers[idx - 1].qty + 1;
                              const isActive = l.qty >= lowerBound && l.qty <= t.qty;
                              const label = tierLabel(sortedTiers, idx);
                              return (
                                <span
                                  key={t.qty}
                                  className={`text-xs rounded-full px-2.5 py-1 font-medium ${
                                    isActive ? 'bg-wave text-white' : 'bg-foam text-ink/50'
                                  }`}
                                >
                                  {label}: {formatMoney(t.price)}
                                </span>
                              );
                            })}
                            {suggestion && (
                              <button
                                onClick={() => updateQty(l.sku, suggestion.newQty)}
                                className="flex items-center gap-1.5 text-xs rounded-full bg-splash/10 text-splash px-2.5 py-1 font-medium hover:bg-splash/20 transition-colors"
                              >
                                <TrendingUp className="h-3 w-3" />
                                Add {suggestion.extraUnits} more ({suggestion.newQty} total) to drop to{' '}
                                {formatMoney(suggestion.newUnitPrice)}/unit - save {formatMoney(suggestion.savingsPerUnit)}
                                /unit
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-foam">
                <td className="px-5 py-4 font-semibold text-deep" colSpan={4}>
                  Total (ex GST)
                </td>
                <td className="px-5 py-4 text-right font-display text-lg text-deep font-bold" colSpan={2}>
                  {formatMoney(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
