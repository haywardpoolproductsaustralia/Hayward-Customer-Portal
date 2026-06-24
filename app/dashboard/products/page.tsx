'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, MapPin, PackageX, Loader2, X, Receipt, AlertCircle } from 'lucide-react';

interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  listPrice?: number | null;
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }>;
}

interface PriceInfo {
  listPrice: number | null;
  price: number | null;
  discountPercent: number | null;
}

interface OrderLine {
  orderNo: string;
  orderDate: string;
  statusFlag: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  customerCode: string;
}

const PAGE_SIZE = 30;

const STATUS_LABELS: Record<string, string> = {
  C: 'Completed',
  A: 'Active',
  X: 'Cancelled',
  B: 'Backordered',
  H: 'On hold',
  S: 'Standing order',
  '': 'Draft',
};

function formatMoney(value: number | null) {
  if (value == null) return null;
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function totalOnHand(byLocation?: StockEntry['byLocation']) {
  if (!byLocation) return 0;
  return Object.values(byLocation).reduce((sum, loc) => sum + (loc.onHand || 0), 0);
}

interface FullPricing {
  listPrice: number | null;
  price: number | null;
  discountPercent: number | null;
  breaks: { qty: number; price: number | null }[];
}

function ProductDetail({ item, onClose }: { item: StockEntry; onClose: () => void }) {
  const [orders, setOrders] = useState<OrderLine[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);

  const [pricing, setPricing] = useState<FullPricing | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setOrdersLoading(true);
    setOrdersError(null);
    fetch(`/api/orders/by-sku?sku=${encodeURIComponent(item.sku)}`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setOrdersError(data.error ?? 'Could not load your order history.');
          setOrders(null);
        } else {
          setOrders(data.orders ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setOrdersError('Could not reach the server. Try refreshing the page.');
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.sku]);

  useEffect(() => {
    let cancelled = false;
    setPricingLoading(true);
    setPricingError(null);
    fetch(`/api/pricing?sku=${encodeURIComponent(item.sku)}&qty=1`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setPricingError(data.error ?? 'Could not load pricing for this product.');
          setPricing(null);
        } else {
          setPricing(data);
        }
      })
      .catch(() => {
        if (!cancelled) setPricingError('Could not reach the server. Try refreshing the page.');
      })
      .finally(() => {
        if (!cancelled) setPricingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.sku]);

  const locations = Object.entries(item.byLocation ?? {});

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-soft w-full sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-ink/10 px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-ink leading-snug">{item.name || item.sku}</p>
            <p className="text-xs text-ink/40 font-mono mt-0.5">{item.sku}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-ink/5 flex-shrink-0">
            <X className="h-4 w-4 text-ink/50" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <p className="text-xs font-semibold text-ink/40 uppercase tracking-wide mb-2">Pricing</p>
            {pricingLoading ? (
              <div className="flex items-center gap-2 text-sm text-ink/40 py-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading pricing...
              </div>
            ) : pricingError ? (
              <div className="flex items-start gap-2 rounded-xl bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{pricingError}</span>
              </div>
            ) : pricing ? (
              <div className="space-y-2">
                {pricing.listPrice != null && (
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-ink/50">List price</span>
                    <span className="text-ink/70 font-medium">{formatMoney(pricing.listPrice)}</span>
                  </div>
                )}
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-ink/50">Your price (qty 1)</span>
                  <div className="flex items-baseline gap-2">
                    <span className="font-display text-xl text-deep font-bold">
                      {formatMoney(pricing.price) ?? 'On request'}
                    </span>
                    {pricing.discountPercent ? (
                      <span className="text-xs font-semibold text-sunset">-{pricing.discountPercent}%</span>
                    ) : null}
                  </div>
                </div>
                {pricing.breaks.length > 0 && (
                  <div className="pt-2 border-t border-ink/5 space-y-1.5">
                    <p className="text-xs text-ink/40 mb-1">Buy more, pay less</p>
                    {pricing.breaks.map((b) => (
                      <div key={b.qty} className="flex items-baseline justify-between text-sm">
                        <span className="text-ink/60">Qty {b.qty}+</span>
                        <span className="font-medium text-ink">{formatMoney(b.price) ?? 'On request'} each</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-sm text-ink/30">Price on request</span>
            )}
          </div>

          {locations.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-ink/40 uppercase tracking-wide mb-2">Stock by location</p>
              <div className="flex flex-wrap gap-2">
                {locations.map(([loc, qty]) => (
                  <span
                    key={loc}
                    className="inline-flex items-center gap-1.5 rounded-full bg-foam px-3 py-1.5 text-xs font-medium text-ink/70"
                  >
                    <MapPin className="h-3 w-3 text-wave" />
                    {loc}: {qty.onHand} on hand
                    {qty.backordered ? <span className="text-amber"> · {qty.backordered} backordered</span> : null}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-ink/40 uppercase tracking-wide mb-2">Your orders for this product</p>
            {ordersLoading ? (
              <div className="flex items-center gap-2 text-sm text-ink/40 py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading order history...
              </div>
            ) : ordersError ? (
              <div className="flex items-start gap-2 rounded-xl bg-amber/10 px-3.5 py-2.5 text-sm text-amber">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{ordersError}</span>
              </div>
            ) : orders && orders.length > 0 ? (
              <div className="space-y-2">
                {orders.map((o, i) => (
                  <div
                    key={`${o.orderNo}-${i}`}
                    className="flex items-center justify-between rounded-xl bg-foam px-3.5 py-2.5 text-sm"
                  >
                    <div>
                      <p className="font-medium text-ink">Order {o.orderNo}</p>
                      <p className="text-xs text-ink/40">{formatDate(o.orderDate)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-ink/70">
                        {o.qtyShipped}/{o.qtyOrdered} shipped
                      </p>
                      <p className="text-xs text-ink/40">{STATUS_LABELS[o.statusFlag] ?? (o.statusFlag || 'Unknown')}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-ink/40 py-4">
                <Receipt className="h-4 w-4" /> No past orders found for this product.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


export default function ProductsPage() {
  const [query, setQuery] = useState('');
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
    if (!trimmed) return allStock;
    return allStock.filter(
      (r) => r.sku.includes(trimmed) || (r.name ?? '').toUpperCase().includes(trimmed)
    );
  }, [query, allStock]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [query]);

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
  }, [currentPage, query, allStock.length]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Products</h1>
        <p className="text-ink/50 mt-1">Search stock and pricing across every location.</p>
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
        <ProductDetail item={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
