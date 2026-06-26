'use client';

import { useEffect, useState } from 'react';
import {
  Loader2, CheckCircle2, AlertCircle, PackageCheck,
  Package, Printer, ChevronDown, ChevronUp, TrendingUp, AlertTriangle
} from 'lucide-react';
import type { FulfillableOrder, FulfillableLine } from '@/app/api/warehouse/fulfillment/route';

interface Summary {
  totalOrders: number;
  fullyFulfillable: number;
  partiallyFulfillable: number;
  totalBackorderValue: number;
  totalFulfillableValue: number;
}

const AUD = (v: number | null) =>
  v == null ? '-' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(v);

const DATE = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString('en-AU', {
        day: '2-digit', month: 'short', year: 'numeric',
        timeZone: 'Australia/Sydney',
      });
};

function OrderCard({ order }: { order: FulfillableOrder }) {
  const [expanded, setExpanded] = useState(order.fullyFulfillable);

  return (
    <div className={`rounded-2xl bg-white border shadow-soft overflow-hidden ${
      order.fullyFulfillable ? 'border-splash/30' : 'border-ink/10'
    }`}>
      {/* Order header */}
      <div
        className="px-5 py-4 flex items-center justify-between gap-3 cursor-pointer hover:bg-foam/50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          {order.fullyFulfillable ? (
            <CheckCircle2 className="h-5 w-5 text-splash flex-shrink-0" />
          ) : (
            <AlertCircle className="h-5 w-5 text-amber flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-deep">{order.customerName}</p>
              <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${
                order.fullyFulfillable
                  ? 'bg-splash/10 text-splash'
                  : 'bg-amber/10 text-amber'
              }`}>
                {order.fullyFulfillable ? 'Ready to dispatch' : 'Partial'}
              </span>
            </div>
            <p className="text-xs text-ink/50 mt-0.5">
              Order {order.orderNo}
              {order.customerOrderNo && ` · Your ref: ${order.customerOrderNo}`}
              {' · '}Due {DATE(order.expectedDate)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6 flex-shrink-0">
          <div className="text-right hidden sm:block">
            <p className="text-xs text-ink/40">Can ship now</p>
            <p className="font-semibold text-splash">{AUD(order.orderFulfillableValue)}</p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-xs text-ink/40">Total backorder</p>
            <p className="font-semibold text-ink">{AUD(order.orderBackorderValue)}</p>
          </div>
          {expanded
            ? <ChevronUp className="h-4 w-4 text-ink/40" />
            : <ChevronDown className="h-4 w-4 text-ink/40" />}
        </div>
      </div>

      {/* Line items */}
      {expanded && (
        <div className="border-t border-ink/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-foam text-ink/40 text-left">
                <th className="px-5 py-2.5 font-medium">SKU / Product</th>
                <th className="px-4 py-2.5 font-medium text-right">Backorder</th>
                <th className="px-4 py-2.5 font-medium text-right">On hand</th>
                <th className="px-4 py-2.5 font-medium text-right">Can ship</th>
                <th className="px-4 py-2.5 font-medium text-right">Unit price</th>
                <th className="px-4 py-2.5 font-medium text-right">Backorder $</th>
                <th className="px-4 py-2.5 font-medium text-right">Ship now $</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <LineRow key={line.sku} line={line} />
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-foam border-t border-ink/10">
                <td colSpan={5} className="px-5 py-3 font-semibold text-ink">
                  Order totals
                </td>
                <td className="px-4 py-3 text-right font-semibold text-ink">
                  {AUD(order.orderBackorderValue)}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-splash">
                  {AUD(order.orderFulfillableValue)}
                </td>
                <td className="px-4 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function LineRow({ line }: { line: FulfillableLine }) {
  const shortage = line.qtyBackordered - line.onHandTotal;
  return (
    <tr className={`border-b border-ink/5 last:border-0 ${
      line.canFullyFulfil ? '' : 'bg-amber/5'
    }`}>
      <td className="px-5 py-3">
        <p className="font-medium text-ink">{line.productName || line.sku}</p>
        <p className="text-xs text-ink/40 font-mono">{line.sku}</p>
      </td>
      <td className="px-4 py-3 text-right text-ink">{line.qtyBackordered}</td>
      <td className={`px-4 py-3 text-right font-medium ${
        line.canFullyFulfil ? 'text-splash' : 'text-amber'
      }`}>{line.onHandTotal}</td>
      <td className="px-4 py-3 text-right font-semibold text-deep">{line.fulfillableQty}</td>
      <td className="px-4 py-3 text-right text-ink/70">{AUD(line.unitPrice)}</td>
      <td className="px-4 py-3 text-right text-ink">{AUD(line.lineBackorderValue)}</td>
      <td className="px-4 py-3 text-right text-splash font-medium">
        {AUD(line.lineFulfillableValue)}
      </td>
      <td className="px-4 py-3 text-right">
        {!line.canFullyFulfil && shortage > 0 && (
          <span className="text-[11px] text-amber font-medium">
            Short {shortage}
          </span>
        )}
        {line.canFullyFulfil && (
          <span className="text-[11px] text-splash font-medium">✓</span>
        )}
      </td>
    </tr>
  );
}

export default function WarehousePage() {
  const [orders, setOrders] = useState<FulfillableOrder[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | 'partial'>('all');

  useEffect(() => {
    fetch('/api/warehouse/fulfillment')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) {
          setError(data.error ?? 'Could not load fulfillment data.');
        } else {
          setOrders(data.orders ?? []);
          setSummary(data.summary ?? null);
        }
      })
      .catch(() => setError('Could not reach the server.'))
      .finally(() => setLoading(false));
  }, []);

  function printPickList() {
    const visible = filteredOrders;
    const lines: string[] = [
      'HAYWARD POOL PRODUCTS — WAREHOUSE PICK LIST',
      `Generated: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`,
      `Showing: ${filter === 'all' ? 'All fulfillable' : filter === 'ready' ? 'Ready to dispatch' : 'Partially fulfillable'}`,
      '',
    ];
    for (const o of visible) {
      lines.push(`ORDER ${o.orderNo}  ${o.customerName}  Due: ${DATE(o.expectedDate)}`);
      if (o.customerOrderNo) lines.push(`  Customer ref: ${o.customerOrderNo}`);
      lines.push(`  Status: ${o.fullyFulfillable ? 'READY TO DISPATCH' : 'PARTIAL'}`);
      for (const l of o.lines) {
        if (l.fulfillableQty > 0) {
          lines.push(`  [  ] ${l.sku.padEnd(20)} ${l.productName ?? ''}`);
          lines.push(`       Pick: ${l.fulfillableQty} / ${l.qtyBackordered} backordered   (${l.onHandTotal} on hand)`);
        }
      }
      lines.push(`  Fulfillable value: ${AUD(o.orderFulfillableValue)}`);
      lines.push('');
    }
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      `<html><head><title>Pick List</title><style>body{font-family:monospace;font-size:13px;padding:24px;white-space:pre}</style></head><body>${
        lines.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')
      }</body></html>`
    );
    w.document.close();
    w.focus();
    w.print();
  }

  const filteredOrders =
    filter === 'ready'
      ? orders.filter((o) => o.fullyFulfillable)
      : filter === 'partial'
      ? orders.filter((o) => !o.fullyFulfillable)
      : orders;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-ink/40 py-16 justify-center">
        <Loader2 className="h-5 w-5 animate-spin" /> Computing fulfillable orders...
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-coral py-8">{error}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">Warehouse fulfillment</h1>
          <p className="text-ink/50 mt-1">
            Backordered lines that can be dispatched from current stock.
          </p>
        </div>
        <button
          onClick={printPickList}
          disabled={filteredOrders.length === 0}
          className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2 disabled:opacity-50"
        >
          <Printer className="h-4 w-4" /> Print pick list
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
            <div className="flex items-center gap-2 text-ink/40 mb-1.5">
              <PackageCheck className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Ready</span>
            </div>
            <p className="font-display text-3xl font-bold text-splash">{summary.fullyFulfillable}</p>
            <p className="text-xs text-ink/40 mt-0.5">orders</p>
          </div>
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
            <div className="flex items-center gap-2 text-ink/40 mb-1.5">
              <Package className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Partial</span>
            </div>
            <p className="font-display text-3xl font-bold text-amber">{summary.partiallyFulfillable}</p>
            <p className="text-xs text-ink/40 mt-0.5">orders</p>
          </div>
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
            <div className="flex items-center gap-2 text-ink/40 mb-1.5">
              <TrendingUp className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Can ship now</span>
            </div>
            <p className="font-display text-2xl font-bold text-splash">
              {AUD(summary.totalFulfillableValue)}
            </p>
          </div>
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
            <div className="flex items-center gap-2 text-ink/40 mb-1.5">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Total backorder</span>
            </div>
            <p className="font-display text-2xl font-bold text-ink">
              {AUD(summary.totalBackorderValue)}
            </p>
          </div>
        </div>
      )}

      {/* Alert banner for fully ready orders */}
      {summary && summary.fullyFulfillable > 0 && (
        <div className="rounded-2xl bg-splash/10 border border-splash/20 px-5 py-3.5 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-splash flex-shrink-0" />
          <p className="text-sm font-medium text-splash">
            {summary.fullyFulfillable} order{summary.fullyFulfillable > 1 ? 's are' : ' is'} ready
            to dispatch in full — all backordered lines have sufficient stock on hand.
          </p>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 border-b border-ink/10">
        {([['all', 'All', summary?.totalOrders], ['ready', 'Ready to dispatch', summary?.fullyFulfillable], ['partial', 'Partial', summary?.partiallyFulfillable]] as const).map(
          ([val, label, count]) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                filter === val
                  ? 'border-wave text-deep'
                  : 'border-transparent text-ink/40 hover:text-ink/60'
              }`}
            >
              {label}
              <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                filter === val ? 'bg-wave/10 text-wave' : 'bg-ink/5 text-ink/40'
              }`}>{count}</span>
            </button>
          )
        )}
      </div>

      {filteredOrders.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <Package className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No orders in this category right now.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredOrders.map((o) => (
            <OrderCard key={o.orderNo} order={o} />
          ))}
        </div>
      )}
    </div>
  );
}
