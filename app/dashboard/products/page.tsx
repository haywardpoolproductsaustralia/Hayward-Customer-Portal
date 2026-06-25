'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, PackageX, Loader2, AlertCircle } from 'lucide-react';
import { ProductDetailModal, StockEntry } from '@/components/ProductDetailModal';

const PAGE_SIZE = 30;

// Keyword-based, not tied to Arrow's STOCK_CATEGORY codes - those are
// cryptic 2-character codes with no reliable name mapping we've found.
// This matches product names instead, using the same category groupings
// already established for the manuals library.
const CATEGORIES: { label: string; keywords: string[] }[] = [
  { label: 'Pumps', keywords: ['PUMP'] },
  { label: 'Filters', keywords: ['FILTER'] },
  { label: 'Heaters', keywords: ['HEAT'] },
  { label: 'Cleaners', keywords: ['CLEANER', 'TIGERSHARK', 'AQUANAUT', 'TRACVAC', 'POWERSHARK', 'NAVIGATOR', 'POOLVAC', 'ROBOTIC'] },
  { label: 'Automation', keywords: ['CHLORINAT', 'AQUARITE', 'OMNILOGIC', 'SALT', 'PLUG'] },
];

interface PriceInfo {
  listPrice: number | null;
  price: number | null;
  discountPercent: number | null;
}

function formatMoney(value: number | null) {
  if (value == null) return null;
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

function totalOnHand(byLocation?: StockEntry['byLocation']) {
  if (!byLocation) return 0;
  return Object.values(byLocation).reduce((sum, loc) => sum + (loc.onHand || 0), 0);
}

export default function ProductsPage() {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [allStock, setAllStock] = useState<StockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricingAccessError, setPricingAccessError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/stock');
        const data = await res.json();
        if (!cancelled) {
          if (!res.ok) setError(data.error ?? 'Could not load products right now.');
          else setAllStock(data.results ?? []);
        }
      } catch {
        if (!cancelled) setError('Could not reach the product list right now. Try again in a moment.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadAll();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toUpperCase();
    const category = CATEGORIES.find((c) => c.label === activeCategory);

    return allStock.filter((r) => {
      const haystack = `${r.sku} ${r.name ?? ''} ${r.supplierStock ?? ''}`.toUpperCase();
      if (trimmed && !haystack.includes(trimmed)) return false;
      if (category && !category.keywords.some((kw) => haystack.includes(kw))) return false;
      return true;
    });
  }, [query, activeCategory, allStock]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [query, activeCategory]);

  useEffect(() => {
    if (visible.length === 0) return;
    let cancelled = false;

    async function loadPrices() {
      setPricesLoading(true);
      try {
        const res = await fetch('/api/pricing/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: visible.map((v) => ({ sku: v.sku, stockCategory: v.stockCategory, listPrice: v.listPrice })),
            qty: 1,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setPricingAccessError(data.error ?? 'Could not load pricing right now.');
          return;
        }
        setPricingAccessError(null);
        const next: Record<string, PriceInfo> = {};
        for (const r of data.results ?? []) {
          next[r.sku] = { listPrice: r.listPrice, price: r.price, discountPercent: r.discountPercent };
        }
        setPrices((prev) => ({ ...prev, ...next }));
      } catch {
        if (!cancelled) setPricingAccessError('Could not reach pricing right now.');
      } finally {
        if (!cancelled) setPricesLoading(false);
      }
    }

    loadPrices();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, query, activeCategory, allStock.length]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Products</h1>
        <p className="text-ink/50 mt-1">Search stock and pricing across every location.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setActiveCategory(null)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            activeCategory === null ? 'bg-wave text-white' : 'bg-white border border-ink/10 text-ink/60 hover:border-wave/30'
          }`}
        >
          All
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.label}
            onClick={() => setActiveCategory((prev) => (prev === c.label ? null : c.label))}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeCategory === c.label
                ? 'bg-wave text-white'
                : 'bg-white border border-ink/10 text-ink/60 hover:border-wave/30'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="relative max-w-lg">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by SKU or product name"
          className="w-full rounded-full border border-ink/10 bg-white pl-11 pr-4 py-3 text-sm shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-ink/40 py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading products...
        </div>
      )}
      {error && <p className="text-sm text-coral">{error}</p>}

      {pricingAccessError && (
        <div className="flex items-start gap-2 rounded-2xl bg-amber/10 border border-amber/20 px-4 py-3 text-sm text-amber">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{pricingAccessError} Stock is still shown below, but prices can&apos;t be calculated until this is resolved.</span>
        </div>
      )}

      {!loading && !error && (
        <>
          <p className="text-xs text-ink/40">
            {filtered.length} {filtered.length === 1 ? 'product' : 'products'}
            {activeCategory && ` in ${activeCategory}`}
            {query && ` matching "${query}"`}
          </p>

          {filtered.length === 0 ? (
            <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
              <PackageX className="h-8 w-8 text-ink/20" />
              <p className="text-ink/40">No products matched that search.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {visible.map((item) => {
                const stock = totalOnHand(item.byLocation);
                const price = prices[item.sku];
                return (
                  <button
                    key={item.sku}
                    onClick={() => setSelected(item)}
                    className="text-left rounded-xl bg-white border border-ink/10 shadow-soft p-3 flex flex-col gap-2 hover:shadow-glow hover:border-wave/20 transition-all"
                  >
                    <div>
                      <p className="text-sm font-semibold text-ink leading-snug line-clamp-2">
                        {item.name || item.sku}
                      </p>
                      <p className="text-[11px] text-ink/40 mt-0.5 font-mono">{item.sku}</p>
                    </div>

                    {stock > 0 ? (
                      <span className="inline-flex items-center self-start gap-1 rounded-full bg-splash/10 text-splash px-2 py-0.5 text-[11px] font-semibold">
                        {stock} in stock
                      </span>
                    ) : (
                      <span className="inline-flex items-center self-start gap-1 rounded-full bg-amber/10 text-amber px-2 py-0.5 text-[11px] font-semibold">
                        Out of stock
                      </span>
                    )}

                    <div className="mt-auto pt-2 border-t border-ink/5">
                      {pricesLoading && !price ? (
                        <span className="text-[11px] text-ink/30">Pricing...</span>
                      ) : price?.price != null ? (
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="font-display text-base text-deep font-bold">
                            {formatMoney(price.price)}
                          </span>
                          {price.discountPercent ? (
                            <span className="text-[11px] font-semibold text-sunset">
                              -{price.discountPercent}%
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-[11px] text-ink/30">Price on request</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {pageCount > 1 && (
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="rounded-full border border-ink/10 bg-white px-4 py-2 text-sm font-medium shadow-soft disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-ink/40">
                Page {currentPage + 1} of {pageCount}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={currentPage >= pageCount - 1}
                className="rounded-full border border-ink/10 bg-white px-4 py-2 text-sm font-medium shadow-soft disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {selected && (
        <ProductDetailModal item={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
