'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  XCircle,
  PauseCircle,
  FileText,
  ReceiptText,
  Search,
  Download,
  Loader2,
} from 'lucide-react';

interface OrderLine {
  orderNo: string;
  customerOrderNo: string | null;
  orderDate: string;
  expectedDate: string;
  invoiceDate: string | null;
  statusFlag: string;
  sku: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  customerCode: string;
  branchName: string;
}

const STATUS: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  C: { label: 'Completed', icon: CheckCircle2, className: 'bg-ink/5 text-ink/50' },
  A: { label: 'Active', icon: Clock, className: 'bg-wave/10 text-wave' },
  X: { label: 'Cancelled', icon: XCircle, className: 'bg-coral/10 text-coral' },
  B: { label: 'Backordered', icon: PauseCircle, className: 'bg-amber/10 text-amber' },
  H: { label: 'On hold', icon: PauseCircle, className: 'bg-amber/10 text-amber' },
  S: { label: 'Standing order', icon: ReceiptText, className: 'bg-wave/10 text-wave' },
  '': { label: 'Draft', icon: FileText, className: 'bg-ink/5 text-ink/50' },
};

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderLine[]>([]);
  const [isHeadOffice, setIsHeadOffice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [orderNoSearch, setOrderNoSearch] = useState('');
  const [customerOrderNoSearch, setCustomerOrderNoSearch] = useState('');
  const [skuSearch, setSkuSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/orders')
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError(data.error ?? 'Could not load orders right now.');
        } else {
          setOrders(data.orders ?? []);
          setIsHeadOffice(Boolean(data.isHeadOffice));
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach the server. Try refreshing the page.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const branchOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of orders) seen.set(o.customerCode, o.branchName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders]);

  const filtered = useMemo(() => {
    const orderNoTrim = orderNoSearch.trim();
    const customerOrderNoTrim = customerOrderNoSearch.trim();
    const skuTrim = skuSearch.trim().toUpperCase();
    const fromTime = dateFrom ? new Date(dateFrom).getTime() : null;
    const toTime = dateTo ? new Date(dateTo).getTime() : null;

    return orders
      .filter((o) => !orderNoTrim || o.orderNo.includes(orderNoTrim))
      .filter((o) => !customerOrderNoTrim || (o.customerOrderNo ?? '').includes(customerOrderNoTrim))
      .filter((o) => !skuTrim || o.sku.toUpperCase().includes(skuTrim))
      .filter((o) => branchFilter === 'all' || o.customerCode === branchFilter)
      .filter((o) => {
        if (!fromTime && !toTime) return true;
        const t = new Date(o.orderDate).getTime();
        if (Number.isNaN(t)) return false;
        if (fromTime && t < fromTime) return false;
        if (toTime && t > toTime) return false;
        return true;
      })
      .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
  }, [orders, orderNoSearch, customerOrderNoSearch, skuSearch, branchFilter, dateFrom, dateTo]);

  function clearFilters() {
    setOrderNoSearch('');
    setCustomerOrderNoSearch('');
    setSkuSearch('');
    setBranchFilter('all');
    setDateFrom('');
    setDateTo('');
  }

  async function exportToExcel() {
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows = filtered.map((o) => ({
        'Order #': o.orderNo,
        'Your order #': o.customerOrderNo ?? '',
        Branch: o.branchName,
        'Order date': formatDate(o.orderDate),
        'Est. delivery': formatDate(o.expectedDate),
        'Invoice date': o.invoiceDate ? formatDate(o.invoiceDate) : 'Not yet invoiced',
        SKU: o.sku,
        Ordered: o.qtyOrdered,
        Shipped: o.qtyShipped,
        Backordered: o.qtyBackordered,
        Status: STATUS[o.statusFlag]?.label ?? (o.statusFlag || 'Unknown'),
      }));
      const sheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, 'Orders');
      const dateStamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `orders-${dateStamp}.xlsx`);
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-ink/40 py-12 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading orders...
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-coral">{error}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">Orders</h1>
          <p className="text-ink/50 mt-1">{isHeadOffice ? 'Across all your locations.' : 'For your location.'}</p>
        </div>
        <button
          onClick={exportToExcel}
          disabled={exporting || filtered.length === 0}
          className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2 disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export to Excel
        </button>
      </div>

      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1">Hayward order #</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/30" />
            <input
              value={orderNoSearch}
              onChange={(e) => setOrderNoSearch(e.target.value)}
              placeholder="e.g. 445822"
              className="w-full rounded-lg border border-ink/10 pl-8 pr-3 py-2 text-sm focus:border-wave outline-none"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1">Your order #</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/30" />
            <input
              value={customerOrderNoSearch}
              onChange={(e) => setCustomerOrderNoSearch(e.target.value)}
              placeholder="e.g. 228031499"
              className="w-full rounded-lg border border-ink/10 pl-8 pr-3 py-2 text-sm focus:border-wave outline-none"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1">SKU</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/30" />
            <input
              value={skuSearch}
              onChange={(e) => setSkuSearch(e.target.value)}
              placeholder="e.g. 1A-AV250LI"
              className="w-full rounded-lg border border-ink/10 pl-8 pr-3 py-2 text-sm focus:border-wave outline-none"
            />
          </div>
        </div>

        {isHeadOffice && (
          <div>
            <label className="block text-xs font-medium text-ink/40 mb-1">Branch</label>
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
            >
              <option value="all">All branches</option>
              {branchOptions.map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1">Order date from</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1">Order date to</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
          />
        </div>

        <div className="sm:col-span-2 lg:col-span-3 flex items-center justify-between pt-1">
          <p className="text-xs text-ink/40">
            {filtered.length} of {orders.length} order line(s)
          </p>
          <button onClick={clearFilters} className="text-xs text-wave font-medium hover:underline">
            Clear filters
          </button>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <ReceiptText className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No orders found in the last 90 days.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <Search className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No orders matched those filters.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-ink/40">
                <th className="px-5 py-3.5 font-medium">Order #</th>
                <th className="px-5 py-3.5 font-medium">Your order #</th>
                {isHeadOffice && <th className="px-5 py-3.5 font-medium">Branch</th>}
                <th className="px-5 py-3.5 font-medium">Order date</th>
                <th className="px-5 py-3.5 font-medium">Est. delivery</th>
                <th className="px-5 py-3.5 font-medium">Invoice date</th>
                <th className="px-5 py-3.5 font-medium">SKU</th>
                <th className="px-5 py-3.5 font-medium text-right">Ordered</th>
                <th className="px-5 py-3.5 font-medium text-right">Shipped</th>
                <th className="px-5 py-3.5 font-medium text-right">Backordered</th>
                <th className="px-5 py-3.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o, i) => {
                const status = STATUS[o.statusFlag] ?? {
                  label: o.statusFlag || 'Unknown',
                  icon: FileText,
                  className: 'bg-ink/5 text-ink/50',
                };
                const StatusIcon = status.icon;
                return (
                  <tr key={`${o.orderNo}-${o.sku}-${i}`} className="border-b border-ink/5 last:border-0">
                    <td className="px-5 py-3.5 font-medium">{o.orderNo}</td>
                    <td className="px-5 py-3.5 text-ink/60">{o.customerOrderNo || '-'}</td>
                    {isHeadOffice && <td className="px-5 py-3.5 text-ink/50">{o.branchName}</td>}
                    <td className="px-5 py-3.5 text-ink/50">{formatDate(o.orderDate)}</td>
                    <td className="px-5 py-3.5 text-ink/50">{formatDate(o.expectedDate)}</td>
                    <td className="px-5 py-3.5 text-ink/50">
                      {o.invoiceDate ? formatDate(o.invoiceDate) : <span className="text-ink/30">Not yet invoiced</span>}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs">{o.sku}</td>
                    <td className="px-5 py-3.5 text-right">{o.qtyOrdered}</td>
                    <td className="px-5 py-3.5 text-right">{o.qtyShipped}</td>
                    <td className="px-5 py-3.5 text-right">{o.qtyBackordered || '-'}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${status.className}`}
                      >
                        <StatusIcon className="h-3 w-3" />
                        {status.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
