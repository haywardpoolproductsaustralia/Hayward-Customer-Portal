'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  ChevronDown,
} from 'lucide-react';
import { useSelectedCustomer } from '@/components/SelectedCustomerContext';
import { SearchableSelect } from '@/components/SearchableSelect';

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
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
}

// Compact date for the table cells: "26 Jun 26" - fits one line in a narrow column.
function shortDate(value: string | null | undefined) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Australia/Sydney' });
}

// Small button + popup for filtering by order status.
function StatusFilter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const current = value === 'all' ? null : options.find((o) => o.value === value);

  function handleBlur(e: React.FocusEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
  }

  return (
    <div onBlur={handleBlur} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-sm transition-colors ${
          open ? 'border-wave ring-2 ring-wave/20' : 'border-ink/10 hover:border-ink/20'
        }`}
      >
        <span className={current ? 'text-ink' : 'text-ink/30'}>{current ? current.label : 'All statuses'}</span>
        <ChevronDown className="h-3.5 w-3.5 text-ink/30 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-ink/10 bg-white shadow-soft overflow-hidden max-h-56 overflow-y-auto">
          <button
            tabIndex={0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onChange('all'); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-foam border-b border-ink/5 ${
              value === 'all' ? 'bg-wave/5 text-wave font-semibold' : 'text-ink'
            }`}
          >
            All statuses
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              tabIndex={0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-foam border-b border-ink/5 last:border-0 ${
                o.value === value ? 'bg-wave/5 text-wave font-semibold' : 'text-ink'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderLine[]>([]);
  const [isHeadOffice, setIsHeadOffice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const { selectedCustomer } = useSelectedCustomer();

  const [orderNoSearch, setOrderNoSearch] = useState('');
  const [customerOrderNoSearch, setCustomerOrderNoSearch] = useState('');
  const [skuSearch, setSkuSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOrders([]);
    const url = selectedCustomer?.code
      ? `/api/orders?customerCode=${encodeURIComponent(selectedCustomer.code)}`
      : '/api/orders';
    fetch(url)
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
  }, [selectedCustomer?.code]);

  const branchOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of orders) seen.set(o.customerCode, o.branchName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders]);

  // Branch as a searchable select: display "name (code)", filter on code.
  const branchLabel = (code: string, name: string) => `${name} (${code})`;
  const branchStringOptions = useMemo(
    () => branchOptions.map(([code, name]) => branchLabel(code, name)),
    [branchOptions],
  );
  const branchCodeByLabel = useMemo(() => {
    const m = new Map<string, string>();
    branchOptions.forEach(([code, name]) => m.set(branchLabel(code, name), code));
    return m;
  }, [branchOptions]);
  const branchLabelByCode = useMemo(() => {
    const m = new Map<string, string>();
    branchOptions.forEach(([code, name]) => m.set(code, branchLabel(code, name)));
    return m;
  }, [branchOptions]);

  // Status options present in the current order set, in a sensible order.
  const statusOptions = useMemo(() => {
    const present = new Set(orders.map((o) => o.statusFlag));
    return Object.keys(STATUS)
      .filter((k) => present.has(k))
      .map((k) => ({ value: k, label: STATUS[k].label }));
  }, [orders]);

  // Unique sorted option lists for the searchable dropdowns
  const orderNoOptions = useMemo(() =>
    [...new Set(orders.map((o) => o.orderNo))].sort(), [orders]);
  const customerOrderNoOptions = useMemo(() =>
    [...new Set(orders.map((o) => o.customerOrderNo).filter((v): v is string => Boolean(v)))].sort(), [orders]);
  const skuOptions = useMemo(() =>
    [...new Set(orders.map((o) => o.sku))].sort(), [orders]);

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
      .filter((o) => statusFilter === 'all' || o.statusFlag === statusFilter)
      .filter((o) => {
        if (!fromTime && !toTime) return true;
        const t = new Date(o.orderDate).getTime();
        if (Number.isNaN(t)) return false;
        if (fromTime && t < fromTime) return false;
        if (toTime && t > toTime) return false;
        return true;
      })
      .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
  }, [orders, orderNoSearch, customerOrderNoSearch, skuSearch, branchFilter, statusFilter, dateFrom, dateTo]);

  function clearFilters() {
    setOrderNoSearch('');
    setCustomerOrderNoSearch('');
    setSkuSearch('');
    setBranchFilter('all');
    setStatusFilter('all');
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
          <p className="text-ink/50 mt-1">
            {selectedCustomer
              ? `Showing orders for ${selectedCustomer.name}.`
              : isHeadOffice
              ? 'Across all your locations.'
              : 'For your location.'}
          </p>
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
        <SearchableSelect
          label="Hayward order #"
          placeholder="e.g. 445822"
          options={orderNoOptions}
          value={orderNoSearch}
          onChange={setOrderNoSearch}
        />
        <SearchableSelect
          label="Your order #"
          placeholder="e.g. 228031499"
          options={customerOrderNoOptions}
          value={customerOrderNoSearch}
          onChange={setCustomerOrderNoSearch}
        />
        <SearchableSelect
          label="SKU"
          placeholder="e.g. 1A-AV250LI"
          options={skuOptions}
          value={skuSearch}
          onChange={setSkuSearch}
        />

        {isHeadOffice && (
          <SearchableSelect
            label="Branch"
            placeholder="All branches"
            mono={false}
            options={branchStringOptions}
            value={branchFilter === 'all' ? '' : (branchLabelByCode.get(branchFilter) ?? '')}
            onChange={(v) => setBranchFilter(v ? (branchCodeByLabel.get(v) ?? 'all') : 'all')}
          />
        )}

        {/* Status + date range share one row; dates are kept narrow so Status fits inline. */}
        <div className="sm:col-span-2 lg:col-span-2">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <label className="block text-xs font-medium text-ink/40 mb-1">Status</label>
              <StatusFilter value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
            </div>
            <div className="w-36 shrink-0">
              <label className="block text-xs font-medium text-ink/40 mb-1">Order date from</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
              />
            </div>
            <div className="w-36 shrink-0">
              <label className="block text-xs font-medium text-ink/40 mb-1">Order date to</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
              />
            </div>
          </div>
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
        <div className="rounded-2xl border border-ink/10 bg-white shadow-soft overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-ink/40 align-bottom">
                <th className="px-3 py-3 font-medium w-[8%]">Order #</th>
                <th className="px-3 py-3 font-medium w-[9%]">Your order #</th>
                {isHeadOffice && <th className="px-3 py-3 font-medium w-[16%]">Branch</th>}
                <th className="px-3 py-3 font-medium w-[8%]">Order date</th>
                <th className="px-3 py-3 font-medium w-[8%]">Est. delivery</th>
                <th className="px-3 py-3 font-medium w-[8%]">Invoice date</th>
                <th className="px-3 py-3 font-medium w-[11%]">SKU</th>
                <th className="px-3 py-3 font-medium text-right w-[7%]">Ordered</th>
                <th className="px-3 py-3 font-medium text-right w-[7%]">Shipped</th>
                <th className="px-3 py-3 font-medium text-right w-[7%]">B/Order</th>
                <th className="px-3 py-3 font-medium w-[11%]">Status</th>
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
                  <tr key={`${o.orderNo}-${o.sku}-${i}`} className="border-b border-ink/5 last:border-0 align-top">
                    <td className="px-3 py-3 font-medium break-words">{o.orderNo}</td>
                    <td className="px-3 py-3 text-ink/60 break-words">{o.customerOrderNo || '-'}</td>
                    {isHeadOffice && <td className="px-3 py-3 text-ink/50 break-words">{o.branchName}</td>}
                    <td className="px-3 py-3 text-ink/50">{shortDate(o.orderDate)}</td>
                    <td className="px-3 py-3 text-ink/50">{shortDate(o.expectedDate)}</td>
                    <td className="px-3 py-3 text-ink/50">
                      {o.invoiceDate ? shortDate(o.invoiceDate) : <span className="text-ink/30">Pending</span>}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs break-all">{o.sku}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{o.qtyOrdered}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{o.qtyShipped}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{o.qtyBackordered || '-'}</td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}
                      >
                        <StatusIcon className="h-3 w-3 shrink-0" />
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
