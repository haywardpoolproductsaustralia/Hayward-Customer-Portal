'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, Hourglass, PackageX, DollarSign, Truck, AlertTriangle,
  ChevronDown, ChevronUp, Download, ListFilter, ArrowUpDown, X, Search,
  Boxes, Building2, Info, Layers,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import type { SlowStockRecord, SlowStockResponse, SlowAction, AgeBand } from '@/app/api/slow-stock/route';

// ---------------------------------------------------------------------------
// Slow-moving stock - staff only. Portal version of slow_moving_stock.xlsx.
// Data comes from /api/slow-stock, which reads the nightly forecast:all key;
// nothing on this page recomputes anything heavy.
// ---------------------------------------------------------------------------

type SortKey =
  | 'name' | 'stockValue' | 'excessValue12' | 'excessValueSeasonal12'
  | 'coverFlat' | 'coverSeasonal' | 'monthsSinceLastSale' | 'onHand' | 'sales24';
type View = 'list' | 'suppliers';
type QuickFilter = null | 'excess' | 'dead' | 'buying';

const AUD = (v: number | null | undefined) =>
  v == null
    ? '-'
    : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(v);
const NUM = (v: number | null | undefined) =>
  v == null ? '-' : new Intl.NumberFormat('en-AU').format(Math.round(v));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ACTION_STYLE: Record<SlowAction, { label: string; cls: string; hint: string }> = {
  clear:         { label: 'Clear',        cls: 'bg-coral/10 text-coral',   hint: 'No sale in the dead window - write down, bundle, or clear.' },
  'stop-buying': { label: 'Stop buying',  cls: 'bg-amber/10 text-amber',   hint: 'Still sells, but years of cover - cancel/hold POs, cut Arrow min/reorder.' },
  review:        { label: 'Review',       cls: 'bg-wave/10 text-wave',     hint: 'Over the cover target but not badly - check before the next buy.' },
  ok:            { label: 'OK',           cls: 'bg-splash/10 text-splash', hint: 'Cover within target.' },
};
const ACTION_ORDER: SlowAction[] = ['clear', 'stop-buying', 'review', 'ok'];
const AGE_ORDER: AgeBand[] = ['<12m', '12-24m', '24-36m', '36m+'];
const AGE_LABEL: Record<AgeBand, string> = { '<12m': 'Sold in last 12m', '12-24m': '12-24m ago', '24-36m': '2-3 years ago', '36m+': '3+ years / never' };

function coverText(m: number | null) {
  if (m == null) return '∞';
  if (m >= 120) return '120+';
  return m.toFixed(1);
}
function coverCls(m: number | null, slow: number) {
  if (m == null) return 'text-coral font-semibold';
  if (m > slow * 2) return 'text-amber font-semibold';
  if (m > slow) return 'text-wave';
  return 'text-splash';
}

// 36 monthly bars; the last 12 are tinted so the "recent" period reads at a glance.
function HistoryBars({ history }: { history: number[] }) {
  const max = Math.max(1, ...history);
  const n = history.length || 1;
  const w = 240;
  const h = 40;
  const bw = w / n;
  return (
    <svg width={w} height={h} role="img" aria-label="monthly sales, last 36 months">
      {history.map((v, i) => {
        const bh = Math.max(v > 0 ? 1.5 : 0, (v / max) * h);
        const recent = i >= n - 12;
        return (
          <rect key={i} x={i * bw + 0.5} y={h - bh} width={Math.max(1, bw - 1)} height={bh}
            fill={recent ? '#0EA5E9' : '#0EA5E9'} opacity={recent ? 0.95 : 0.35} />
        );
      })}
    </svg>
  );
}

function StatCard({
  icon: Icon, label, value, sub, tone, onClick, active,
}: {
  icon: any; label: string; value: string; sub?: string; tone: string;
  onClick?: () => void; active?: boolean;
}) {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left rounded-2xl border shadow-soft px-5 py-4 transition-colors ${
        active ? 'bg-wave/5 border-wave/40 ring-1 ring-wave/30' : 'bg-white border-ink/10'
      } ${clickable ? 'hover:border-wave/30 cursor-pointer' : 'cursor-default'}`}
    >
      <div className="flex items-center gap-2 text-ink/50 text-xs font-medium">
        <Icon className={`h-4 w-4 ${tone}`} />
        {label}
        {clickable && <span className={`ml-auto text-[10px] ${active ? 'text-wave' : 'text-ink/25'}`}>{active ? 'filtering' : 'click to filter'}</span>}
      </div>
      <p className="mt-1 text-2xl font-semibold text-deep tabular-nums">{value}</p>
      {sub && <p className="text-xs text-ink/40 mt-0.5">{sub}</p>}
    </button>
  );
}

function SortHeader({
  label, col, sortKey, sortDir, onSort, className, align = 'right',
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void; className?: string; align?: 'left' | 'right';
}) {
  const active = sortKey === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''} ${active ? 'text-wave' : 'hover:text-ink'} ${className || ''}`}
    >
      <span>{label}</span>
      {active
        ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
        : <ArrowUpDown className="h-3 w-3 opacity-40" />}
    </button>
  );
}

function KV({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink/50 text-xs">{k}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold text-deep' : 'text-ink'}`}>{v}</dd>
    </div>
  );
}

function DetailRow({ r, slow }: { r: SlowStockRecord; slow: number }) {
  const startMonth = (() => {
    const [y, m] = (r.historyStart || '').split('-').map(Number);
    return Number.isFinite(m) ? `${MONTHS[(m - 1) % 12]} ${String(y).slice(2)}` : '';
  })();
  const a = ACTION_STYLE[r.action];
  return (
    <div className="px-5 py-4 bg-foam/60 border-t border-ink/10">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div>
          <p className="text-xs font-medium text-ink/50 mb-2">
            Monthly sales <span className="text-ink/30">(from {startMonth}, last 12 months solid)</span>
          </p>
          <HistoryBars history={r.history} />
          <dl className="mt-3 space-y-1 text-sm">
            <KV k="Last 12 months" v={`${NUM(r.sales12)} units`} />
            <KV k="Last 24 months" v={`${NUM(r.sales24)} units`} />
            <KV k="Avg / month (24m)" v={r.avgMonthly24.toFixed(2)} />
            <KV k="Last sale" v={r.lastSale ? new Date(r.lastSale).toLocaleDateString('en-AU') : (r.monthsSinceLastSale == null ? 'none in window' : `~${r.monthsSinceLastSale}m ago`)} />
            {r.lastPurchase && <KV k="Last purchase" v={new Date(r.lastPurchase).toLocaleDateString('en-AU')} />}
          </dl>
        </div>

        <div className="text-sm">
          <p className="text-xs font-medium text-ink/50 mb-2">Position &amp; cover</p>
          <dl className="space-y-1">
            <KV k="On hand" v={NUM(r.onHand)} strong />
            <KV k="On order" v={NUM(r.onOrder)} />
            {r.backordered > 0 && <KV k="Backordered" v={NUM(r.backordered)} />}
            <KV k="Avg cost" v={AUD(r.avgCost)} />
            <KV k="Stock value" v={AUD(r.stockValue)} strong />
            <KV k="Cover - flat 24m avg" v={`${coverText(r.coverFlat)} mo`} />
            <KV k="Cover - seasonal, incl. on order" v={`${coverText(r.coverSeasonal)} mo`} strong />
            <KV k="Demand pattern" v={r.bucket} />
          </dl>
        </div>

        <div className="text-sm">
          <p className="text-xs font-medium text-ink/50 mb-2">Excess</p>
          <dl className="space-y-1">
            <KV k={`Beyond ${slow}m (flat) - qty`} v={NUM(r.excessQty12)} />
            <KV k={`Beyond ${slow}m (flat) - value`} v={AUD(r.excessValue12)} strong />
            <KV k="Beyond 24m (flat) - value" v={AUD(r.excessValue24)} />
            <KV k="Beyond 12m seasonal, incl. on order" v={AUD(r.excessValueSeasonal12)} strong />
          </dl>
          <div className={`mt-3 rounded-xl px-3 py-2 text-xs ${a.cls}`}>
            <span className="font-semibold">{a.label}</span> · {r.reason}
            <p className="mt-1 opacity-80">{a.hint}</p>
          </div>
          {r.buyingWhileExcess && (
            <p className="mt-2 text-[11px] text-amber flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> {NUM(r.onOrder)} more on order while already in excess.
            </p>
          )}
          <p className="mt-2 text-[11px] text-ink/40 flex items-center gap-1 font-mono">
            <Info className="h-3 w-3" /> {r.supplierName || r.supplierCode || '—'}{r.supplierStock ? ` · ${r.supplierStock}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ r, slow }: { r: SlowStockRecord; slow: number }) {
  const [open, setOpen] = useState(false);
  const a = ACTION_STYLE[r.action];
  return (
    <div className={r.action === 'clear' ? 'bg-coral/[0.025]' : r.buyingWhileExcess ? 'bg-amber/[0.03]' : ''}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-5 py-3 flex items-center gap-4 hover:bg-ink/[0.02]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-ink text-sm truncate">{r.name || r.sku}</span>
            <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${a.cls}`}>{a.label}</span>
            {r.buyingWhileExcess && (
              <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 bg-amber/10 text-amber flex items-center gap-1">
                <Truck className="h-3 w-3" /> {NUM(r.onOrder)} on order
              </span>
            )}
          </div>
          <p className="text-[11px] text-ink/40 font-mono mt-0.5">
            {r.sku}{r.stockCategory ? ` · ${r.stockCategory}` : ''}{r.supplierName ? ` · ${r.supplierName}` : ''}
          </p>
        </div>
        <div className="hidden md:block text-right w-16">
          <p className="text-sm tabular-nums text-ink">{NUM(r.onHand)}</p>
        </div>
        <div className="hidden sm:block text-right w-16">
          <p className="text-sm tabular-nums text-ink">{NUM(r.sales24)}</p>
        </div>
        <div className="hidden lg:block text-right w-20">
          <p className="text-sm tabular-nums text-ink/70">
            {r.monthsSinceLastSale == null ? <span className="text-coral">never</span> : `${r.monthsSinceLastSale}m`}
          </p>
        </div>
        <div className="text-right w-20">
          <p className={`text-sm tabular-nums ${coverCls(r.coverSeasonal, slow)}`}>{coverText(r.coverSeasonal)}</p>
        </div>
        <div className="hidden md:block text-right w-24">
          <p className="text-sm tabular-nums text-ink">{AUD(r.stockValue)}</p>
        </div>
        <div className="text-right w-24">
          <p className={`text-sm tabular-nums ${r.excessValue12 > 0 ? 'font-semibold text-deep' : 'text-ink/30'}`}>
            {r.excessValue12 > 0 ? AUD(r.excessValue12) : '—'}
          </p>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-ink/30" /> : <ChevronDown className="h-4 w-4 text-ink/30" />}
      </button>
      {open && <DetailRow r={r} slow={slow} />}
    </div>
  );
}

function Bar({ value, max, cls }: { value: number; max: number; cls: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 rounded-full bg-ink/5 overflow-hidden">
      <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function SlowStockPage() {
  const [data, setData] = useState<SlowStockResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [supplier, setSupplier] = useState('');
  const [category, setCategory] = useState('');
  const [actionF, setActionF] = useState<'' | SlowAction>('');
  const [ageF, setAgeF] = useState<'' | AgeBand>('');
  const [q, setQ] = useState('');
  const [slowMonths, setSlowMonths] = useState(12);
  const [deadMonths, setDeadMonths] = useState(24);
  const [view, setView] = useState<View>('list');
  const [quick, setQuick] = useState<QuickFilter>(null);

  const [sortKey, setSortKey] = useState<SortKey>('excessValue12');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };
  const toggleQuick = (f: Exclude<QuickFilter, null>) => setQuick((c) => (c === f ? null : f));

  // debounce the search box so we don't hit the API per keystroke
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 250); return () => clearTimeout(t); }, [q]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (supplier) params.set('supplier', supplier);
    if (category) params.set('category', category);
    if (actionF) params.set('action', actionF);
    if (ageF) params.set('age', ageF);
    if (qDebounced) params.set('q', qDebounced);
    params.set('slowMonths', String(slowMonths));
    params.set('deadMonths', String(deadMonths));

    setLoading(true);
    fetch(`/api/slow-stock?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Failed to load slow-moving stock');
        }
        return res.json();
      })
      .then((d: SlowStockResponse) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [supplier, category, actionF, ageF, qDebounced, slowMonths, deadMonths]);

  const visible = useMemo(() => {
    let recs = data?.records ?? [];
    if (quick === 'excess') recs = recs.filter((r) => r.excessValue12 > 0);
    else if (quick === 'dead') recs = recs.filter((r) => r.action === 'clear');
    else if (quick === 'buying') recs = recs.filter((r) => r.buyingWhileExcess);

    const dir = sortDir === 'asc' ? 1 : -1;
    const num = (v: number | null) => (v == null ? Number.POSITIVE_INFINITY : v);
    return [...recs].sort((a, b) => {
      if (sortKey === 'name') return dir * (a.name || a.sku).localeCompare(b.name || b.sku);
      if (sortKey === 'coverFlat' || sortKey === 'coverSeasonal' || sortKey === 'monthsSinceLastSale') {
        return dir * (num(a[sortKey]) - num(b[sortKey]));
      }
      return dir * ((a[sortKey] as number) - (b[sortKey] as number));
    });
  }, [data, quick, sortKey, sortDir]);

  const exportXlsx = () => {
    if (!data) return;
    // Same column names as the old slow_moving_stock.xlsx so anyone with a
    // pivot built on it can drop this in, then the new columns after.
    const rows = visible.map((r) => ({
      STOCK_CODE: r.sku,
      STOCK_DESCRIPTION: r.name,
      STOCK_CATEGORY: r.stockCategory,
      SUPPLIER_CODE: r.supplierCode,
      SUPPLIER_NAME: r.supplierName,
      SUPPLIER_STOCK: r.supplierStock,
      SalesQty_12Months: r.sales12,
      SalesQty_24Months: r.sales24,
      'AvgMonthly Sales_24M': r.avgMonthly24,
      ON_HAND_QTY: r.onHand,
      ON_ORDER_QTY: r.onOrder,
      AVERAGE_COST: r.avgCost,
      Current_Stock_Value: r.stockValue,
      Excess_Qty_12M: r.excessQty12,
      Excess_Value_12M: r.excessValue12,
      Excess_Qty_24M: r.excessQty24,
      Excess_Value_24M: r.excessValue24,
      Last_Sale_Date: r.lastSale ?? '',
      Months_Since_Last_Sale: r.monthsSinceLastSale ?? '',
      Age_Band: r.ageBand,
      Cover_Months_Flat: r.coverFlat ?? '',
      Cover_Months_Seasonal_InclOnOrder: r.coverSeasonal ?? '',
      Excess_Value_Seasonal_12M: r.excessValueSeasonal12,
      Demand_Pattern: r.bucket,
      Buying_While_Excess: r.buyingWhileExcess ? 'Y' : '',
      Action: ACTION_STYLE[r.action].label,
      Reason: r.reason,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Slow Movers');

    const sup = XLSX.utils.json_to_sheet(
      data.summary.bySupplier.map((s) => ({
        Supplier: s.supplierName, Code: s.supplierCode, SKUs_On_Hand: s.skus,
        Stock_Value: s.stockValue, Excess_Value_12M: s.excessValue12, Dead_Value: s.deadValue, On_Order_Value: s.onOrderValue,
      }))
    );
    XLSX.utils.book_append_sheet(wb, sup, 'By Supplier');
    XLSX.writeFile(wb, `hayward-slow-stock-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const s = data?.summary;
  const built = data?.meta?.generatedAt
    ? new Date(data.meta.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' })
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-deep flex items-center gap-2">
            <Hourglass className="h-6 w-6 text-wave" /> Slow-moving stock
          </h1>
          <p className="text-sm text-ink/50 mt-1">
            Stock on hand at 1-MEL &amp; 2-MEL against national sales, valued at average cost.
            {built && <> Built {built} · {data?.meta?.historyMonths}m history.</>}
          </p>
        </div>
        <button
          onClick={exportXlsx}
          disabled={!data || data.records.length === 0}
          className="flex items-center gap-2 text-sm font-medium rounded-xl px-3.5 py-2 bg-white border border-ink/10 shadow-soft text-ink/70 hover:text-ink disabled:opacity-40"
        >
          <Download className="h-4 w-4" /> Export
        </button>
      </div>

      {s && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard icon={DollarSign} tone="text-deep" label="Stock on hand" value={AUD(s.stockValue)} sub={`${NUM(s.skusOnHand)} SKUs at avg cost`} />
          <StatCard icon={Layers} tone="text-wave" label={`Excess beyond ${slowMonths}m`} value={AUD(s.excessValue12)}
            sub={`${s.stockValue ? Math.round((s.excessValue12 / s.stockValue) * 100) : 0}% of stock · ${NUM(s.skusTo50pct)} SKUs = half of it`}
            onClick={() => toggleQuick('excess')} active={quick === 'excess'} />
          <StatCard icon={PackageX} tone="text-coral" label="Dead stock" value={AUD(s.deadValue)} sub={`${NUM(s.deadSkus)} SKUs, no sale in ${deadMonths}m`}
            onClick={() => toggleQuick('dead')} active={quick === 'dead'} />
          <StatCard icon={Truck} tone="text-amber" label="Buying while in excess" value={NUM(s.buyingWhileExcessSkus)} sub={`${AUD(s.buyingWhileExcessValue)} on order`}
            onClick={() => toggleQuick('buying')} active={quick === 'buying'} />
        </div>
      )}

      {/* controls */}
      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-ink/40"><ListFilter className="h-4 w-4" /></div>
        <div className="relative">
          <Search className="h-4 w-4 text-ink/30 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU or name"
            className="text-sm rounded-lg border border-ink/15 pl-8 pr-2.5 py-1.5 bg-white text-ink w-44" />
        </div>
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink max-w-[14rem]">
          <option value="">All suppliers</option>
          {data?.suppliers.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink">
          <option value="">All categories</option>
          {data?.categories.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={actionF} onChange={(e) => setActionF(e.target.value as '' | SlowAction)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink">
          <option value="">All actions</option>
          {ACTION_ORDER.map((a) => <option key={a} value={a}>{ACTION_STYLE[a].label}</option>)}
        </select>
        <select value={ageF} onChange={(e) => setAgeF(e.target.value as '' | AgeBand)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink">
          <option value="">Any last sale</option>
          {AGE_ORDER.map((a) => <option key={a} value={a}>{AGE_LABEL[a]}</option>)}
        </select>

        <div className="flex items-center gap-2 text-xs text-ink/50">
          <span>Slow &gt;</span>
          <input type="number" min={1} max={60} value={slowMonths} onChange={(e) => setSlowMonths(Math.max(1, Number(e.target.value) || 12))}
            className="w-14 rounded-lg border border-ink/15 px-2 py-1 text-ink tabular-nums" />
          <span>mo cover · Dead &gt;</span>
          <input type="number" min={1} max={120} value={deadMonths} onChange={(e) => setDeadMonths(Math.max(1, Number(e.target.value) || 24))}
            className="w-14 rounded-lg border border-ink/15 px-2 py-1 text-ink tabular-nums" />
          <span>mo since sale</span>
        </div>

        <div className="ml-auto flex items-center rounded-lg border border-ink/15 overflow-hidden">
          <button onClick={() => setView('list')} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 ${view === 'list' ? 'bg-wave/10 text-wave' : 'text-ink/50'}`}>
            <Boxes className="h-4 w-4" /> SKUs
          </button>
          <button onClick={() => setView('suppliers')} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 ${view === 'suppliers' ? 'bg-wave/10 text-wave' : 'text-ink/50'}`}>
            <Building2 className="h-4 w-4" /> Suppliers
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20 text-ink/40">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {error && (
        <div className="rounded-2xl bg-white border border-coral/30 shadow-soft px-5 py-4 text-sm text-coral">{error}</div>
      )}

      {!loading && !error && data && s && (
        <>
          {/* breakdown strips: by action and by age */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-5 py-4">
              <p className="text-xs font-medium text-ink/50 mb-3">Stock value by recommended action</p>
              <div className="space-y-2">
                {ACTION_ORDER.map((a) => {
                  const v = s.byAction[a];
                  const cls = a === 'clear' ? 'bg-coral' : a === 'stop-buying' ? 'bg-amber' : a === 'review' ? 'bg-wave' : 'bg-splash';
                  return (
                    <button key={a} onClick={() => setActionF((c) => (c === a ? '' : a))} className="w-full text-left group">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className={`font-medium ${actionF === a ? 'text-wave' : 'text-ink group-hover:text-deep'}`}>{ACTION_STYLE[a].label}</span>
                        <span className="tabular-nums text-ink/70">{AUD(v.stockValue)} <span className="text-ink/40 text-xs">· {NUM(v.skus)} SKUs</span></span>
                      </div>
                      <Bar value={v.stockValue} max={s.stockValue} cls={cls} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-5 py-4">
              <p className="text-xs font-medium text-ink/50 mb-3">Stock value by time since last sale</p>
              <div className="space-y-2">
                {AGE_ORDER.map((a) => {
                  const v = s.byAge[a];
                  const cls = a === '<12m' ? 'bg-splash' : a === '12-24m' ? 'bg-wave' : a === '24-36m' ? 'bg-amber' : 'bg-coral';
                  return (
                    <button key={a} onClick={() => setAgeF((c) => (c === a ? '' : a))} className="w-full text-left group">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className={`font-medium ${ageF === a ? 'text-wave' : 'text-ink group-hover:text-deep'}`}>{AGE_LABEL[a]}</span>
                        <span className="tabular-nums text-ink/70">{AUD(v.stockValue)} <span className="text-ink/40 text-xs">· {NUM(v.skus)} SKUs</span></span>
                      </div>
                      <Bar value={v.stockValue} max={s.stockValue} cls={cls} />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {view === 'list' && (
            <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
              {quick && (
                <div className="px-5 py-2 bg-wave/5 border-b border-wave/15 flex items-center gap-2 text-xs text-wave">
                  <span>
                    Showing only:{' '}
                    {quick === 'excess' && `SKUs with stock beyond ${slowMonths} months cover`}
                    {quick === 'dead' && `dead stock (no sale in ${deadMonths} months)`}
                    {quick === 'buying' && 'SKUs in excess with more on order'}
                  </span>
                  <button onClick={() => setQuick(null)} className="ml-auto flex items-center gap-1 hover:text-deep">
                    <X className="h-3 w-3" /> clear
                  </button>
                </div>
              )}

              <div className="px-5 py-2 flex items-center gap-4 text-[11px] font-medium text-ink/40 border-b border-ink/10 select-none">
                <SortHeader className="flex-1" label="Product" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
                <SortHeader className="hidden md:block w-16" label="on hand" col="onHand" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader className="hidden sm:block w-16" label="sold 24m" col="sales24" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader className="hidden lg:block w-20" label="last sale" col="monthsSinceLastSale" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader className="w-20" label="cover (mo)" col="coverSeasonal" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader className="hidden md:block w-24" label="stock value" col="stockValue" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader className="w-24" label={`excess >${slowMonths}m`} col="excessValue12" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <span className="w-4" />
              </div>

              <div className="divide-y divide-ink/5">
                {visible.length === 0 ? (
                  <p className="text-sm text-ink/50 px-5 py-10 text-center">No SKUs match these filters.</p>
                ) : (
                  visible.slice(0, 300).map((r) => <Row key={r.sku} r={r} slow={slowMonths} />)
                )}
              </div>
              {visible.length > 300 && (
                <p className="text-[11px] text-ink/40 px-5 py-3 text-center border-t border-ink/5">
                  Showing 300 of {NUM(visible.length)} — narrow with filters or use Export for the full set.
                </p>
              )}
            </div>
          )}

          {view === 'suppliers' && (
            <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
              <div className="px-5 py-2 grid grid-cols-[1fr_5rem_7rem_7rem_7rem_7rem] gap-3 text-[11px] font-medium text-ink/40 border-b border-ink/10">
                <span>Supplier</span>
                <span className="text-right">SKUs</span>
                <span className="text-right">stock value</span>
                <span className="text-right">excess &gt;{slowMonths}m</span>
                <span className="text-right">dead</span>
                <span className="text-right">on order</span>
              </div>
              <div className="divide-y divide-ink/5">
                {s.bySupplier.map((g) => {
                  const maxEx = s.bySupplier[0]?.excessValue12 || 1;
                  return (
                    <button key={g.supplierName} onClick={() => { setSupplier(g.supplierName === 'Unknown' ? '' : g.supplierName); setView('list'); }}
                      className="w-full text-left px-5 py-3 grid grid-cols-[1fr_5rem_7rem_7rem_7rem_7rem] gap-3 items-center hover:bg-ink/[0.02]">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink truncate">{g.supplierName}</p>
                        <p className="text-[11px] text-ink/40 font-mono">{g.supplierCode || ''}</p>
                        <div className="mt-1.5"><Bar value={g.excessValue12} max={maxEx} cls="bg-wave" /></div>
                      </div>
                      <span className="text-sm tabular-nums text-right text-ink/70">{NUM(g.skus)}</span>
                      <span className="text-sm tabular-nums text-right text-ink">{AUD(g.stockValue)}</span>
                      <span className="text-sm tabular-nums text-right font-semibold text-deep">{AUD(g.excessValue12)}</span>
                      <span className={`text-sm tabular-nums text-right ${g.deadValue > 0 ? 'text-coral' : 'text-ink/30'}`}>{g.deadValue > 0 ? AUD(g.deadValue) : '—'}</span>
                      <span className={`text-sm tabular-nums text-right ${g.onOrderValue > 0 ? 'text-ink' : 'text-ink/30'}`}>{g.onOrderValue > 0 ? AUD(g.onOrderValue) : '—'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
