'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Search, Plus, Trash2, Loader2, Printer, FileText, TrendingUp } from 'lucide-react';
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

// Picks the price for a given quantity from a sorted tier list: the tier
// with the largest threshold that's <= qty wins (matches the server's
// own quantity-break selection logic in lib/pricing.ts).
function resolvePrice(tiers: PriceTier[], qty: number): number | null {
  let best: number | null = null;
  for (const t of tiers) {
    if (qty >= t.qty) best = t.price;
  }
  return best;
}

interface TierSuggestion {
  extraUnits: number;
  newQty: number;
  newUnitPrice: number;
  savingsPerUnit: number;
  newLineTotal: number;
}

// The next break above the current qty, if one exists and is actually
// cheaper - the "order a few more, pay less per unit" nudge.
function getNextTierSuggestion(tiers: PriceTier[], qty: number, currentUnitPrice: number | null): TierSuggestion | null {
  if (currentUnitPrice == null) return null;
  const sorted = [...tiers].sort((a, b) => a.qty - b.qty);
  const next = sorted.find((t) => t.qty > qty && t.price != null && t.price < currentUnitPrice);
  if (!next || next.price == null) return null;
  return {
    extraUnits: next.qty - qty,
    newQty: next.qty,
    newUnitPrice: next.price,
    savingsPerUnit: currentUnitPrice - next.price,
    newLineTotal: next.price * next.qty,
  };
}

export default function PricingPage() {
  const [query, setQuery] = useState('');
  const [allStock, setAllStock] = useState<StockEntry[]>([]);
  const [stockLoading, setStockLoading] = useState(true);
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const { selectedCustomer } = useSelectedCustomer();

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
    if (lines.length === 0) return;
    setLines((prev) => prev.map((l) => ({ ...l, loading: true, error: null })));
    lines.forEach((l) => refetchLine(l.sku, l.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.code]);

  const searchResults = useMemo(() => {
    const trimmed = query.trim().toUpperCase();
    if (!trimmed) return [];
    const already = new Set(lines.map((l) => l.sku));
    return allStock
      .filter((r) => !already.has(r.sku))
      .filter(
        (r) =>
          r.sku.includes(trimmed) ||
          (r.name ?? '').toUpperCase().includes(trimmed) ||
          (r.supplierStock ?? '').toUpperCase().includes(trimmed)
      )
      .slice(0, 8);
  }, [query, allStock, lines]);

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
                  tiers: [{ qty: 1, price: data.price }, ...(data.breaks ?? [])].sort(
                    (a, b) => a.qty - b.qty
                  ),
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
    setQuery('');
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

      <div className="relative max-w-lg">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={stockLoading ? 'Loading products...' : 'Search by SKU or product name to add it'}
          disabled={stockLoading}
          className="w-full rounded-full border border-ink/10 bg-white pl-11 pr-4 py-3 text-sm shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none disabled:opacity-50"
        />

        {searchResults.length > 0 && (
          <div className="absolute z-10 mt-2 w-full rounded-2xl border border-ink/10 bg-white shadow-soft overflow-hidden">
            {searchResults.map((r) => (
              <button
                key={r.sku}
                onClick={() => addToQuote(r)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-foam border-b border-ink/5 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{r.name || r.sku}</p>
                  <p className="text-xs text-ink/40 font-mono">{r.sku}</p>
                </div>
                <Plus className="h-4 w-4 text-wave flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
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
                        <td colSpan={5} className="px-5 pb-3.5 pt-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-ink/40">Quantity breaks:</span>
                            {sortedTiers.map((t) => {
                              const isActive = t.qty <= l.qty && (sortedTiers.filter((x) => x.qty <= l.qty).slice(-1)[0]?.qty === t.qty);
                              return (
                                <span
                                  key={t.qty}
                                  className={`text-xs rounded-full px-2.5 py-1 font-medium ${
                                    isActive ? 'bg-wave text-white' : 'bg-foam text-ink/50'
                                  }`}
                                >
                                  {t.qty}+: {formatMoney(t.price)}
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
                <td className="px-5 py-4 font-semibold text-deep" colSpan={3}>
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
