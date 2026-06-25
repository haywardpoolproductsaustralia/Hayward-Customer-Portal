'use client';

import { useEffect, useState } from 'react';
import { MapPin, Loader2, X, Receipt, AlertCircle } from 'lucide-react';

export interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  listPrice?: number | null;
  supplierStock?: string | null;
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }>;
}

interface OrderLine {
  orderNo: string;
  customerOrderNo: string | null;
  orderDate: string;
  expectedDate: string;
  invoiceDate: string | null;
  statusFlag: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  customerCode: string;
}

interface FullPricing {
  listPrice: number | null;
  price: number | null;
  discountPercent: number | null;
  breaks: { qty: number; price: number | null }[];
}

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

/**
 * Product detail modal: price (with full quantity-break ladder) + stock
 * by location + this customer's order history for the SKU. Shared
 * between the Products page and the Assistant chat - same component,
 * same data, same behaviour wherever a SKU gets clicked.
 */
export function ProductDetailModal({ item, onClose }: { item: StockEntry; onClose: () => void }) {
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
            {item.supplierStock && (
              <p className="text-xs text-ink/30 font-mono">Supplier code: {item.supplierStock}</p>
            )}
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
                      {o.customerOrderNo && (
                        <p className="text-xs text-ink/50">Your order #{o.customerOrderNo}</p>
                      )}
                      <p className="text-xs text-ink/40">Ordered {formatDate(o.orderDate)}</p>
                      <p className="text-xs text-ink/40">Est. delivery {formatDate(o.expectedDate)}</p>
                      <p className="text-xs text-ink/40">
                        {o.invoiceDate ? `Invoiced ${formatDate(o.invoiceDate)}` : 'Not yet invoiced'}
                      </p>
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
