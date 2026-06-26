'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, CheckCircle2, AlertCircle, PackageCheck,
  Package, Download, ChevronDown, ChevronUp,
  TrendingUp, AlertTriangle, Container, SlidersHorizontal
} from 'lucide-react';
import type { FulfillableOrder, FulfillableLine } from '@/app/api/warehouse/fulfillment/route';
import { SearchableSelect } from '@/components/SearchableSelect';

interface Summary {
  totalOrders: number;
  fullyFulfillable: number;
  partiallyFulfillable: number;
  containerOrders: number;
  totalBackorderValue: number;
  totalFulfillableValue: number;
}

const AUD = (v: number | null | undefined) =>
  v == null
    ? '-'
    : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(v);

const DATE = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString('en-AU', {
        day: '2-digit', month: 'short', year: 'numeric',
        timeZone: 'Australia/Sydney',
      });
};

function LineRow({ line }: { line: FulfillableLine }) {
  const shortage = line.qtyBackordered - line.onHandTotal;
  return (
    <tr className={`border-b border-ink/5 last:border-0 ${line.canFullyFulfil ? '' : 'bg-amber/5'}`}>
      <td className="px-5 py-3">
        <p className="font-medium text-ink text-sm">{line.productName || line.sku}</p>
        <p className="text-xs text-ink/40 font-mono">{line.sku}</p>
      </td>
      <td className="px-4 py-3 text-right text-sm text-ink">{line.qtyBackordered}</td>
      <td className={`px-4 py-3 text-right text-sm font-medium ${
        line.canFullyFulfil ? 'text-splash' : 'text-amber'
      }`}>{line.onHandTotal}</td>
      <td className="px-4 py-3 text-right text-sm font-semibold text-deep">{line.fulfillableQty}</td>
      <td className="px-4 py-3 text-right text-sm text-ink/70">{AUD(line.unitPrice)}</td>
      <td className="px-4 py-3 text-right text-sm text-ink">{AUD(line.lineBackorderValue)}</td>
      <td className="px-4 py-3 text-right text-sm font-medium text-splash">{AUD(line.lineFulfillableValue)}</td>
      <td className="px-4 py-3 text-right">
        {!line.canFullyFulfil && shortage > 0 ? (
          <span className="text-[11px] text-amber font-medium">Short {shortage}</span>
        ) : (
          <span className="text-[11px] text-splash font-medium">✓</span>
        )}
      </td>
    </tr>
  );
}

function OrderCard({ order }: { order: FulfillableOrder }) {
  const [expanded, setExpanded] = useState(order.fullyFulfillable);
  return (
    <div className={`rounded-2xl bg-white border shadow-soft overflow-hidden ${
      order.fullyFulfillable ? 'border-splash/30' : 'border-ink/10'
    }`}>
      <div
        className="px-5 py-4 flex items-center justify-between gap-3 cursor-pointer hover:bg-foam/50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          {order.fullyFulfillable
            ? <CheckCircle2 className="h-5 w-5 text-splash flex-shrink-0" />
            : <AlertCircle className="h-5 w-5 text-amber flex-shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-deep">{order.customerName}</p>
              <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${
                order.fullyFulfillable ? 'bg-splash/10 text-splash' : 'bg-amber/10 text-amber'
              }`}>
                {order.fullyFulfillable ? 'Ready to dispatch' : 'Partial'}
              </span>
              {order.isContainer && (
                <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-sunset/10 text-sunset flex items-center gap-1">
                  <Container className="h-3 w-3" /> Container
                </span>
              )}
            </div>
            <p className="text-xs text-ink/50 mt-0.5">
              Order {order.orderNo}
              {order.customerOrderNo && ` · Ref: ${order.customerOrderNo}`}
              {order.orderDescn1 && ` · ${order.orderDescn1}`}
              {' · '}Due {DATE(order.expectedDate)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5 flex-shrink-0">
          <div className="text-right hidden sm:block">
            <p className="text-xs text-ink/40">Can ship now</p>
            <p className="font-semibold text-splash text-sm">{AUD(order.orderFulfillableValue)}</p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-xs text-ink/40">Total backorder</p>
            <p className="font-semibold text-ink text-sm">{AUD(order.orderBackorderValue)}</p>
          </div>
          {expanded
            ? <ChevronUp className="h-4 w-4 text-ink/40" />
            : <ChevronDown className="h-4 w-4 text-ink/40" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-ink/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-foam text-ink/40 text-left">
                <th className="px-5 py-2.5 font-medium">SKU / Product</th>
                <th className="px-4 py-2.5 font-medium text-right">Backorder</th>
                <th className="px-4 py-2.5 font-medium text-right">On hand</th>
                <th className="px-4 py-2.5 font-medium text-right">Ship qty</th>
                <th className="px-4 py-2.5 font-medium text-right">Unit price</th>
                <th className="px-4 py-2.5 font-medium text-right">Backorder $</th>
                <th className="px-4 py-2.5 font-medium text-right">Ship now $</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => <LineRow key={l.sku} line={l} />)}
            </tbody>
            <tfoot>
              <tr className="bg-foam border-t border-ink/10">
                <td colSpan={5} className="px-5 py-3 font-semibold text-ink text-sm">Totals</td>
                <td className="px-4 py-3 text-right font-semibold text-ink text-sm">
                  {AUD(order.orderBackorderValue)}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-splash text-sm">
                  {AUD(order.orderFulfillableValue)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

type SortMode = 'value' | 'duedate';
type FilterMode = 'all' | 'ready' | 'partial' | 'container';

export default function WarehousePage() {
  const [orders, setOrders] = useState<FulfillableOrder[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('value');
  const [branchFilter, setBranchFilter] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetch('/api/warehouse/fulfillment')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) setError(data.error ?? 'Could not load fulfillment data.');
        else { setOrders(data.orders ?? []); setSummary(data.summary ?? null); }
      })
      .catch(() => setError('Could not reach the server.'))
      .finally(() => setLoading(false));
  }, []);

  const branchOptions = useMemo(
    () => [...new Set(orders.map((o) => o.customerName))].sort(),
    [orders]
  );

  const displayed = useMemo(() => {
    let list = [...orders];

    if (filterMode === 'ready') list = list.filter((o) => o.fullyFulfillable);
    else if (filterMode === 'partial') list = list.filter((o) => !o.fullyFulfillable);
    else if (filterMode === 'container') list = list.filter((o) => o.isContainer);

    if (branchFilter) list = list.filter((o) => o.customerName === branchFilter);

    if (sortMode === 'value') {
      list.sort((a, b) => {
        if (a.fullyFulfillable !== b.fullyFulfillable) return a.fullyFulfillable ? -1 : 1;
        return b.orderFulfillableValue - a.orderFulfillableValue;
      });
    } else {
      list.sort((a, b) => {
        if (a.fullyFulfillable !== b.fullyFulfillable) return a.fullyFulfillable ? -1 : 1;
        return new Date(a.expectedDate).getTime() - new Date(b.expectedDate).getTime();
      });
    }

    return list;
  }, [orders, filterMode, sortMode, branchFilter]);

  async function exportExcel() {
    if (displayed.length === 0) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows: Record<string, string | number>[] = [];

      for (const o of displayed) {
        for (const l of o.lines) {
          if (l.fulfillableQty === 0) continue;
          rows.push({
            'Order #': o.orderNo,
            'Customer ref': o.customerOrderNo ?? '',
            'Customer / Branch': o.customerName,
            'Order notes': o.orderDescn1 ?? '',
            'Container order': o.isContainer ? 'Yes' : 'No',
            'Status': o.fullyFulfillable ? 'Ready to dispatch' : 'Partial',
            'Due date': DATE(o.expectedDate),
            'SKU': l.sku,
            'Product name': l.productName ?? '',
            'Backorder qty': l.qtyBackordered,
            'On hand': l.onHandTotal,
            'Ship qty': l.fulfillableQty,
            'Unit price (AUD)': l.unitPrice ?? '',
            'Backorder value (AUD)': l.lineBackorderValue ?? '',
            'Ship now value (AUD)': l.lineFulfillableValue ?? '',
          });
        }
        // Subtotal row per order
        rows.push({
          'Order #': '',
          'Customer ref': '',
          'Customer / Branch': `↳ Order ${o.orderNo} totals`,
          'Order notes': '',
          'Container order': '',
          'Status': '',
          'Due date': '',
          'SKU': '',
          'Product name': '',
          'Backorder qty': '',
          'On hand': '',
          'Ship qty': '',
          'Unit price (AUD)': '',
          'Backorder value (AUD)': o.orderBackorderValue,
          'Ship now value (AUD)': o.orderFulfillableValue,
        });
      }

      const ws = XLSX.utils.json_to_sheet(rows);

      // Column widths
      ws['!cols'] = [
        { wch: 10 }, { wch: 14 }, { wch: 30 }, { wch: 30 }, { wch: 14 },
        { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 35 },
        { wch: 12 }, { wch: 10 }, { wch: 10 },
        { wch: 16 }, { wch: 20 }, { wch: 20 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Pick List');
      const dateStamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `hayward-pick-list-${dateStamp}.xlsx`);
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-ink/40 py-16 justify-center">
        <Loader2 className="h-5 w-5 animate-spin" /> Computing fulfillable orders...
      </div>
    );
  }
  if (error) return <p className="text-sm text-coral py-8">{error}</p>;

  const tabs: { val: FilterMode; label: string; count: number | undefined; color: string }[] = [
    { val: 'all', label: 'All', count: summary?.totalOrders, color: 'text-ink/40' },
    { val: 'ready', label: 'Ready', count: summary?.fullyFulfillable, color: 'text-splash' },
    { val: 'partial', label: 'Partial', count: summary?.partiallyFulfillable, color: 'text-amber' },
    { val: 'container', label: 'Container orders', count: summary?.containerOrders, color: 'text-sunset' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">Warehouse fulfillment</h1>
          <p className="text-ink/50 mt-1">Backordered lines that can be dispatched from current stock.</p>
        </div>
        <button
          onClick={exportExcel}
          disabled={exporting || displayed.length === 0}
          className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2 disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export to Excel
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
            <div className="flex items-center gap-2 text-ink/40 mb-1.5">
              <PackageCheck className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Ready to dispatch</span>
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
            <p className="font-display text-2xl font-bold text-splash">{AUD(summary.totalFulfillableValue)}</p>
          </div>
          <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
            <div className="flex items-center gap-2 text-ink/40 mb-1.5">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Total backorder</span>
            </div>
            <p className="font-display text-2xl font-bold text-ink">{AUD(summary.totalBackorderValue)}</p>
          </div>
        </div>
      )}

      {/* Alert banner */}
      {summary && summary.fullyFulfillable > 0 && (
        <div className="rounded-2xl bg-splash/10 border border-splash/20 px-5 py-3.5 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-splash flex-shrink-0" />
          <p className="text-sm font-medium text-splash">
            {summary.fullyFulfillable} order{summary.fullyFulfillable > 1 ? 's are' : ' is'} ready
            to dispatch in full — worth {AUD(
              orders.filter((o) => o.fullyFulfillable).reduce((s, o) => s + o.orderFulfillableValue, 0)
            )} in revenue.
          </p>
        </div>
      )}

      {/* Filters row */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Filter tabs */}
        <div className="flex gap-1 border border-ink/10 rounded-xl p-1 bg-white shadow-soft">
          {tabs.map(({ val, label, count, color }) => (
            <button
              key={val}
              onClick={() => setFilterMode(val)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filterMode === val
                  ? 'bg-wave text-white shadow-sm'
                  : 'text-ink/60 hover:bg-foam'
              }`}
            >
              {val === 'container' && <Container className="h-3 w-3" />}
              {label}
              {count !== undefined && (
                <span className={`${filterMode === val ? 'text-white/70' : color} font-bold`}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Sort toggle */}
        <div className="flex items-center gap-1.5 border border-ink/10 rounded-xl p-1 bg-white shadow-soft">
          <SlidersHorizontal className="h-3.5 w-3.5 text-ink/40 ml-2" />
          <button
            onClick={() => setSortMode('value')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sortMode === 'value' ? 'bg-wave text-white' : 'text-ink/60 hover:bg-foam'
            }`}
          >
            Biggest value first
          </button>
          <button
            onClick={() => setSortMode('duedate')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sortMode === 'duedate' ? 'bg-wave text-white' : 'text-ink/60 hover:bg-foam'
            }`}
          >
            Due date
          </button>
        </div>

        {/* Branch filter */}
        <div className="w-64">
          <SearchableSelect
            label=""
            placeholder="Filter by branch…"
            options={branchOptions}
            value={branchFilter}
            onChange={setBranchFilter}
          />
        </div>
      </div>

      {/* Order count */}
      <p className="text-xs text-ink/40">
        Showing {displayed.length} of {orders.length} fulfillable orders
        {branchFilter && ` for ${branchFilter}`}
      </p>

      {displayed.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <Package className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No orders match the current filters.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {displayed.map((o) => <OrderCard key={o.orderNo} order={o} />)}
        </div>
      )}
    </div>
  );
}
