'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  PackageX,
  Loader2,
  AlertCircle,
  Truck,
  LayoutGrid,
  List,
  ArrowUpDown,
  UserRound,
  X,
} from 'lucide-react';
import { ProductDetailModal, StockEntry } from '@/components/ProductDetailModal';
import { useSelectedCustomer } from '@/components/SelectedCustomerContext';
import { PriceListExportButton } from '@/components/PriceListExportButton';

// Products load progressively as you scroll - one long page, no pagination.
// CHUNK is also the size of each pricing request.
const CHUNK = 60;
const LAYOUT_KEY = 'products:layout';

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

// Catalogue filter. Distinct from the keyword CATEGORIES above: those match on
// product name, these are decided server-side by /api/stock from the caller's
// Clerk org. Paramount is a PERMISSION boundary (its own pr:stock:* namespace),
// so availableViews is whatever the API says it is - never assumed here.
type StockView = 'all' | 'hayward' | 'paramount' | 'flowcontrol';

type Layout = 'grid' | 'list';

// Price sorting is deliberately absent: prices are only fetched for the
// visible page, so sorting the full list by price would be a lie.
type SortKey = 'default' | 'name' | 'sku' | 'stock';
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'default', label: 'Default order' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'sku', label: 'SKU A–Z' },
  { value: 'stock', label: 'Most in stock' },
];

function formatMoney(value: number | null) {
  if (value == null) return null;
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

function shortDate(value: string | null | undefined) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });
}

function totalOnHand(byLocation?: StockEntry['byLocation']) {
  if (!byLocation) return 0;
  return Object.values(byLocation).reduce((sum, loc) => sum + (loc.onHand || 0), 0);
}

function StockPill({ stock, compact = false }: { stock: number; compact?: boolean }) {
  const base = `inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${compact ? 'text-[11px]' : 'text-[11px]'}`;
  return stock > 0 ? (
    <span className={`${base} bg-splash/10 text-splash`}>{stock} in stock</span>
  ) : (
    <span className={`${base} bg-amber/10 text-amber`}>Out of stock</span>
  );
}

function IncomingLine({ item }: { item: StockEntry }) {
  if (!item.incoming || item.incoming.onOrderQty <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-wave">
      <Truck className="h-3 w-3" />
      {item.incoming.onOrderQty} on the way
      {item.incoming.nextEta ? ` · ${shortDate(item.incoming.nextEta)}` : ''}
    </span>
  );
}

function PriceCell({ price, loading, align = 'left' }: { price?: PriceInfo; loading: boolean; align?: 'left' | 'right' }) {
  const wrap = align === 'right' ? 'justify-end' : '';
  if (loading && !price) return <span className="text-[11px] text-ink/30">Pricing...</span>;
  if (price?.price != null) {
    return (
      <div className={`flex items-baseline gap-1.5 flex-wrap ${wrap}`}>
        <span className="font-display text-base text-deep font-bold">{formatMoney(price.price)}</span>
        {price.discountPercent ? (
          <span className="text-[11px] font-semibold text-sunset">-{price.discountPercent}%</span>
        ) : null}
      </div>
    );
  }
  return <span className="text-[11px] text-ink/30">Price on request</span>;
}

export default function ProductsPage() {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [allStock, setAllStock] = useState<StockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(CHUNK);
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricingAccessError, setPricingAccessError] = useState<string | null>(null);
  const [pricingReason, setPricingReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockEntry | null>(null);
  const [view, setView] = useState<StockView>('all');
  const [availableViews, setAvailableViews] = useState<StockView[]>([]);
  const [viewLabels, setViewLabels] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState<Layout>('grid');
  const [sort, setSort] = useState<SortKey>('default');
  const { selectedCustomer } = useSelectedCustomer();

  // Grid/list is a per-browser convenience, not account state.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LAYOUT_KEY);
      if (saved === 'grid' || saved === 'list') setLayout(saved);
    } catch {
      /* private mode etc. - grid is fine */
    }
  }, []);
  function chooseLayout(next: Layout) {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ view });
        // Staff "Pricing as" a customer: show only what that customer can see.
        if (selectedCustomer?.code) params.set('customerCode', selectedCustomer.code);
        const res = await fetch(`/api/stock?${params.toString()}`);
        const data = await res.json();
        if (!cancelled) {
          if (!res.ok) setError(data.error ?? 'Could not load products right now.');
          else {
            setAllStock(data.results ?? []);
            // The server clamps the view to what this org may actually see, so
            // trust its answer over local state rather than showing a filter
            // that wasn't applied.
            if (data.view) setView(data.view as StockView);
            setAvailableViews((data.availableViews ?? []) as StockView[]);
            setViewLabels(data.viewLabels ?? {});
          }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCustomer?.code]);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toUpperCase();
    const category = CATEGORIES.find((c) => c.label === activeCategory);

    const rows = allStock.filter((r) => {
      const haystack = `${r.sku} ${r.name ?? ''} ${r.supplierStock ?? ''}`.toUpperCase();
      if (trimmed && !haystack.includes(trimmed)) return false;
      if (category && !category.keywords.some((kw) => haystack.includes(kw))) return false;
      return true;
    });

    if (sort === 'default') return rows;
    const sorted = [...rows];
    if (sort === 'name') sorted.sort((a, b) => (a.name ?? a.sku).localeCompare(b.name ?? b.sku));
    else if (sort === 'sku') sorted.sort((a, b) => a.sku.localeCompare(b.sku));
    else if (sort === 'stock') sorted.sort((a, b) => totalOnHand(b.byLocation) - totalOnHand(a.byLocation));
    return sorted;
  }, [query, activeCategory, allStock, sort]);

  const stockSummary = useMemo(() => {
    let inStock = 0;
    let incoming = 0;
    for (const r of filtered) {
      if (totalOnHand(r.byLocation) > 0) inStock += 1;
      if (r.incoming && r.incoming.onOrderQty > 0) incoming += 1;
    }
    return { inStock, incoming, out: filtered.length - inStock };
  }, [filtered]);

  const visible = filtered.slice(0, limit);
  const hasMore = limit < filtered.length;

  useEffect(() => {
    setLimit(CHUNK);
  }, [query, activeCategory, view, sort]);

  // Prices are per customer, so a change of "pricing as" invalidates them all.
  useEffect(() => {
    setPrices({});
  }, [selectedCustomer?.code, view]);

  // Reveal the next chunk when the sentinel below the list scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => Math.min(l + CHUNK, filtered.length));
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, filtered.length]);

  // Price only what's newly on screen and not already priced; merge, never reset.
  const unpriced = useMemo(() => visible.filter((v) => !(v.sku in prices)), [visible, prices]);
  useEffect(() => {
    if (unpriced.length === 0) return;
    let cancelled = false;
    const items = unpriced.slice(0, CHUNK);

    const unanswered = () =>
      Object.fromEntries(items.map((v) => [v.sku, { listPrice: v.listPrice ?? null, price: null, discountPercent: null }]));

    async function loadPrices() {
      setPricesLoading(true);
      try {
        const res = await fetch('/api/pricing/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: items.map((v) => ({ sku: v.sku, stockCategory: v.stockCategory, listPrice: v.listPrice })),
            qty: 1,
            customerCode: selectedCustomer?.code,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setPricingAccessError(data.error ?? 'Could not load pricing right now.');
          setPricingReason(typeof data.reason === 'string' ? data.reason : null);
          // Mark this batch as "asked" so a failing endpoint isn't hammered on
          // every scroll; a customer change clears the map and retries.
          setPrices((prev) => ({ ...prev, ...unanswered() }));
          return;
        }
        setPricingAccessError(null);
        setPricingReason(null);
        const next: Record<string, PriceInfo> = {};
        for (const r of data.results ?? []) {
          next[r.sku] = { listPrice: r.listPrice, price: r.price, discountPercent: r.discountPercent };
        }
        setPrices((prev) => ({ ...prev, ...next }));
      } catch {
        if (!cancelled) {
          setPricingAccessError('Could not reach pricing right now.');
          setPricingReason(null);
          setPrices((prev) => ({ ...prev, ...unanswered() }));
        }
      } finally {
        if (!cancelled) setPricesLoading(false);
      }
    }

    loadPrices();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unpriced, selectedCustomer?.code]);

  const needsCustomer = pricingReason === 'select_customer';

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">Products</h1>
          <p className="text-ink/50 mt-1">Search stock and pricing across every location.</p>
        </div>
        <PriceListExportButton />
      </div>

      {availableViews.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {availableViews.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                view === v
                  ? 'bg-deep text-white'
                  : 'bg-white border border-deep/15 text-deep/70 hover:border-deep/40'
              }`}
            >
              {viewLabels[v] ?? v}
            </button>
          ))}
        </div>
      )}

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

      {/* Toolbar: full-width search, sort, grid/list toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by SKU or product name"
            className="w-full rounded-full border border-ink/10 bg-white pl-11 pr-10 py-3 text-sm shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink/30 hover:text-ink/60 hover:bg-ink/5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="relative">
          <ArrowUpDown className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/40" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort products"
            className="appearance-none rounded-full border border-ink/10 bg-white pl-9 pr-8 py-3 text-xs font-medium text-ink/70 shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none cursor-pointer"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[10px] text-ink/40">▾</span>
        </div>

        <div className="inline-flex rounded-full border border-ink/10 bg-white p-1 shadow-soft">
          <button
            onClick={() => chooseLayout('grid')}
            aria-label="Grid view"
            aria-pressed={layout === 'grid'}
            className={`rounded-full p-2 transition-colors ${layout === 'grid' ? 'bg-deep text-white' : 'text-ink/50 hover:text-deep'}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => chooseLayout('list')}
            aria-label="List view"
            aria-pressed={layout === 'list'}
            className={`rounded-full p-2 transition-colors ${layout === 'list' ? 'bg-deep text-white' : 'text-ink/50 hover:text-deep'}`}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-ink/40 py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading products...
        </div>
      )}
      {error && <p className="text-sm text-coral">{error}</p>}

      {pricingAccessError && needsCustomer && (
        <div className="flex items-start gap-2 rounded-2xl bg-foam border border-wave/20 px-4 py-3 text-sm text-deep">
          <UserRound className="h-4 w-4 flex-shrink-0 mt-0.5 text-wave" />
          <span>
            Showing stock for all customers. Pick a customer from the <span className="font-semibold">All customers</span>{' '}
            menu at the top right to see their pricing.
          </span>
        </div>
      )}
      {pricingAccessError && !needsCustomer && (
        <div className="flex items-start gap-2 rounded-2xl bg-amber/10 border border-amber/20 px-4 py-3 text-sm text-amber">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{pricingAccessError}. Stock is still shown below, but prices can&apos;t be calculated until this is resolved.</span>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink/40">
            <p>
              {hasMore ? `${visible.length} of ` : ''}
              {filtered.length} {filtered.length === 1 ? 'product' : 'products'}
              {view !== 'all' && viewLabels[view] ? ` · ${viewLabels[view]}` : ''}
              {activeCategory && ` in ${activeCategory}`}
              {query && ` matching "${query}"`}
            </p>
            {filtered.length > 0 && (
              <p className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-splash" />
                  {stockSummary.inStock} in stock
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-wave" />
                  {stockSummary.incoming} on the way
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber" />
                  {stockSummary.out} out of stock
                </span>
              </p>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
              <PackageX className="h-8 w-8 text-ink/20" />
              <p className="text-ink/40">No products matched that search.</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
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

                    <div className="flex flex-col items-start gap-1">
                      <StockPill stock={stock} />
                      <IncomingLine item={item} />
                    </div>

                    <div className="mt-auto pt-2 border-t border-ink/5">
                      <PriceCell price={price} loading={pricesLoading} />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl bg-white border border-ink/10 shadow-soft">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink/40 border-b border-ink/10 bg-foam/60">
                    <th className="px-4 py-3 font-semibold w-44">SKU</th>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 font-semibold w-36">Availability</th>
                    <th className="px-4 py-3 font-semibold w-48">On the way</th>
                    <th className="px-4 py-3 font-semibold text-right w-40">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => {
                    const stock = totalOnHand(item.byLocation);
                    const price = prices[item.sku];
                    const incoming = item.incoming && item.incoming.onOrderQty > 0 ? item.incoming : null;
                    return (
                      <tr
                        key={item.sku}
                        onClick={() => setSelected(item)}
                        className="border-b border-ink/5 last:border-0 hover:bg-foam/50 cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-2.5 font-mono text-xs text-ink/60 whitespace-nowrap">{item.sku}</td>
                        <td className="px-4 py-2.5 font-medium text-ink">{item.name || item.sku}</td>
                        <td className="px-4 py-2.5">
                          <StockPill stock={stock} compact />
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {incoming ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-wave">
                              <Truck className="h-3 w-3" />
                              {incoming.onOrderQty}
                              {incoming.nextEta ? ` · ${shortDate(incoming.nextEta)}` : ''}
                            </span>
                          ) : (
                            <span className="text-xs text-ink/25">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <PriceCell price={price} loading={pricesLoading} align="right" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Scroll sentinel - reveals the next chunk; also a manual fallback. */}
          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-6">
              <button
                onClick={() => setLimit((l) => Math.min(l + CHUNK, filtered.length))}
                className="inline-flex items-center gap-2 rounded-full border border-ink/10 bg-white px-4 py-2 text-xs font-medium text-ink/60 shadow-soft hover:border-wave/30"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-ink/30" />
                Loading more · {filtered.length - visible.length} to go
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
