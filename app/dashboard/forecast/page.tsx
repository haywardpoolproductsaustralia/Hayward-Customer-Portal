'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, TrendingUp, AlertTriangle, PackageX, DollarSign,
  ChevronDown, ChevronUp, Download, Container, ListFilter,
  Boxes, Clock, Truck, Info,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import type { ForecastRecord, ForecastResponse } from '@/app/api/forecast/route';

const AUD = (v: number | null | undefined) =>
  v == null
    ? '-'
    : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(v);

const NUM = (v: number | null | undefined) =>
  v == null ? '-' : new Intl.NumberFormat('en-AU').format(Math.round(v));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BUCKET_STYLE: Record<string, { label: string; cls: string }> = {
  smooth: { label: 'Smooth', cls: 'bg-splash/10 text-splash' },
  erratic: { label: 'Erratic', cls: 'bg-amber/10 text-amber' },
  intermittent: { label: 'Intermittent', cls: 'bg-wave/10 text-wave' },
  lumpy: { label: 'Lumpy', cls: 'bg-sunset/10 text-sunset' },
  dead: { label: 'Dead', cls: 'bg-ink/10 text-ink/50' },
};

function coverStyle(months: number, below: boolean) {
  if (months >= 900) return 'text-ink/40';
  if (below && months < 1) return 'text-coral font-semibold';
  if (below) return 'text-amber font-semibold';
  return 'text-splash';
}

// History (solid) + forecast (dashed) on one baseline. A glance is enough to
// read the shape - the table carries the precise numbers.
function Sparkline({ history, forecast }: { history: number[]; forecast: number[] }) {
  const all = [...history, ...forecast];
  const max = Math.max(1, ...all);
  const w = 240;
  const h = 44;
  const n = all.length;
  const step = n > 1 ? w / (n - 1) : w;
  const pt = (v: number, i: number) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`;
  const histPts = history.map((v, i) => pt(v, i)).join(' ');
  const fcStart = history.length - 1;
  const fcPts = forecast.map((v, i) => pt(v, fcStart + 1 + i));
  const bridge = history.length ? `${pt(history[history.length - 1], fcStart)} ${fcPts.join(' ')}` : fcPts.join(' ');

  return (
    <svg width={w} height={h} className="overflow-visible" role="img" aria-label="demand history and forecast">
      <polyline points={histPts} fill="none" stroke="#0EA5E9" strokeWidth="1.75" />
      <polyline points={bridge} fill="none" stroke="#FB5607" strokeWidth="1.75" strokeDasharray="3 3" />
    </svg>
  );
}

function StatCard({
  icon: Icon, label, value, sub, tone,
}: {
  icon: any; label: string; value: string; sub?: string; tone: string;
}) {
  return (
    <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-5 py-4">
      <div className="flex items-center gap-2 text-ink/50 text-xs font-medium">
        <Icon className={`h-4 w-4 ${tone}`} />
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold text-deep tabular-nums">{value}</p>
      {sub && <p className="text-xs text-ink/40 mt-0.5">{sub}</p>}
    </div>
  );
}

function DetailRow({ r }: { r: ForecastRecord }) {
  const startMonth = (() => {
    const [y, m] = r.historyStart.split('-').map(Number);
    return MONTHS[(m - 1) % 12] + ' ' + String(y).slice(2);
  })();

  return (
    <div className="px-5 py-4 bg-foam/60 border-t border-ink/10">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* demand shape */}
        <div>
          <p className="text-xs font-medium text-ink/50 mb-2">
            Demand &amp; forecast <span className="text-ink/30">(from {startMonth})</span>
          </p>
          <Sparkline history={r.history} forecast={r.forecast} />
          <div className="flex gap-3 mt-2 text-[11px] text-ink/50">
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-wave" /> actual</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-sunset" /> forecast</span>
            <span className="ml-auto">{r.method} · ADI {r.adi} · CV² {r.cv2}</span>
          </div>
        </div>

        {/* replenishment math */}
        <div className="text-sm">
          <p className="text-xs font-medium text-ink/50 mb-2">Why this number</p>
          <dl className="space-y-1">
            <Line k="Forecast / month" v={NUM(r.monthlyForecast)} />
            <Line k="Lead time" v={`${r.leadTimeDays} days`} />
            <Line k="Safety stock" v={NUM(r.safetyStock)} />
            <Line k="Reorder point" v={NUM(r.reorderPoint)} />
            <Line k="Position (on hand + on order − committed)" v={NUM(r.position)} strong />
          </dl>
        </div>

        {/* arrow comparison + cost */}
        <div className="text-sm">
          <p className="text-xs font-medium text-ink/50 mb-2">Against Arrow &amp; cost</p>
          <dl className="space-y-1">
            <Line k="Arrow minimum qty" v={NUM(r.arrowMinimumQty)} />
            <Line k="Arrow reorder qty" v={NUM(r.arrowReorderQty)} />
            <Line k="Avg cost (official)" v={AUD(r.avgCost)} />
            <Line k="Suggested buy" v={NUM(r.suggestedQty)} strong />
            <Line k="Buy value" v={AUD(r.suggestedValue)} strong />
          </dl>
          {r.wmape != null && (
            <p className="mt-2 text-[11px] text-ink/40 flex items-center gap-1">
              <Info className="h-3 w-3" />
              Backtest: {r.wmape}% error, bias {r.bias > 0 ? '+' : ''}{r.bias}
              {r.bias < -2 ? ' (runs low)' : r.bias > 2 ? ' (runs high)' : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink/50 text-xs">{k}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold text-deep' : 'text-ink'}`}>{v}</dd>
    </div>
  );
}

function Row({ r }: { r: ForecastRecord }) {
  const [open, setOpen] = useState(false);
  const b = BUCKET_STYLE[r.bucket] ?? BUCKET_STYLE.dead;
  return (
    <div className={`${r.belowReorder ? 'bg-amber/[0.03]' : ''}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-5 py-3 flex items-center gap-4 hover:bg-ink/[0.02]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-ink text-sm truncate">{r.name || r.sku}</span>
            <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${b.cls}`}>{b.label}</span>
          </div>
          <p className="text-[11px] text-ink/40 font-mono mt-0.5">
            {r.sku}{r.supplierName ? ` · ${r.supplierName}` : ''}
          </p>
        </div>

        <div className="hidden sm:block text-right w-20">
          <p className="text-[11px] text-ink/40">fcast/mo</p>
          <p className="text-sm tabular-nums text-ink">{NUM(r.monthlyForecast)}</p>
        </div>
        <div className="text-right w-20">
          <p className="text-[11px] text-ink/40">cover</p>
          <p className={`text-sm tabular-nums ${coverStyle(r.coverMonths, r.belowReorder)}`}>
            {r.coverMonths >= 900 ? '∞' : `${r.coverMonths}m`}
          </p>
        </div>
        <div className="text-right w-24">
          <p className="text-[11px] text-ink/40">buy</p>
          <p className={`text-sm tabular-nums ${r.suggestedQty > 0 ? 'font-semibold text-deep' : 'text-ink/30'}`}>
            {r.suggestedQty > 0 ? NUM(r.suggestedQty) : '—'}
          </p>
        </div>
        <div className="hidden md:block text-right w-24">
          <p className="text-[11px] text-ink/40">value</p>
          <p className="text-sm tabular-nums text-ink">{r.suggestedValue > 0 ? AUD(r.suggestedValue) : '—'}</p>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-ink/30" /> : <ChevronDown className="h-4 w-4 text-ink/30" />}
      </button>
      {open && <DetailRow r={r} />}
    </div>
  );
}

// Group buys by supplier and total them toward a container target - the way
// imported pool gear actually gets ordered (fill an FCL, not one SKU at a time).
function SupplierGroups({ records, target }: { records: ForecastRecord[]; target: number }) {
  const groups = useMemo(() => {
    const m = new Map<string, ForecastRecord[]>();
    for (const r of records) {
      if (r.suggestedQty <= 0) continue;
      const key = r.supplierName || r.supplierCode || 'Unknown supplier';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return [...m.entries()]
      .map(([supplier, items]) => ({
        supplier,
        items: items.sort((a, b) => b.suggestedValue - a.suggestedValue),
        value: items.reduce((s, r) => s + r.suggestedValue, 0),
        lines: items.length,
      }))
      .sort((a, b) => b.value - a.value);
  }, [records]);

  if (groups.length === 0) {
    return <p className="text-sm text-ink/50 px-1 py-8 text-center">Nothing is below its reorder point right now.</p>;
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const fill = target > 0 ? Math.min(100, (g.value / target) * 100) : 0;
        const ready = g.value >= target;
        return (
          <details key={g.supplier} className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
            <summary className="px-5 py-4 flex items-center gap-3 cursor-pointer hover:bg-ink/[0.02] list-none">
              <Truck className="h-5 w-5 text-wave flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-deep">{g.supplier}</p>
                <p className="text-xs text-ink/50">{g.lines} lines · {AUD(g.value)} at cost</p>
                {target > 0 && (
                  <div className="mt-1.5 h-1.5 rounded-full bg-ink/10 overflow-hidden max-w-xs">
                    <div className={`h-full ${ready ? 'bg-splash' : 'bg-wave'}`} style={{ width: `${fill}%` }} />
                  </div>
                )}
              </div>
              {target > 0 && (
                <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${ready ? 'bg-splash/10 text-splash' : 'bg-ink/5 text-ink/50'}`}>
                  {ready ? 'Container ready' : `${Math.round(fill)}% of target`}
                </span>
              )}
            </summary>
            <div className="border-t border-ink/10 divide-y divide-ink/5">
              {g.items.map((r) => (
                <div key={r.sku} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="text-ink truncate">{r.name || r.sku}</p>
                    <p className="text-[11px] text-ink/40 font-mono">{r.sku}{r.supplierStock ? ` · supp ${r.supplierStock}` : ''}</p>
                  </div>
                  <span className="tabular-nums text-ink/60 w-16 text-right">{NUM(r.suggestedQty)} ea</span>
                  <span className="tabular-nums font-medium text-deep w-24 text-right">{AUD(r.suggestedValue)}</span>
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export default function ForecastPage() {
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [supplier, setSupplier] = useState('');
  const [category, setCategory] = useState('');
  const [bucket, setBucket] = useState('');
  const [needReorder, setNeedReorder] = useState(false);
  const [view, setView] = useState<'list' | 'suppliers'>('list');
  const [containerTarget, setContainerTarget] = useState(60000);

  useEffect(() => {
    const params = new URLSearchParams();
    if (supplier) params.set('supplier', supplier);
    if (category) params.set('category', category);
    if (bucket) params.set('bucket', bucket);
    if (needReorder) params.set('needReorder', '1');

    setLoading(true);
    fetch(`/api/forecast?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || 'Failed to load forecast');
        }
        return res.json();
      })
      .then((d: ForecastResponse) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [supplier, category, bucket, needReorder]);

  const exportXlsx = () => {
    if (!data) return;
    const rows = data.records.map((r) => ({
      SKU: r.sku, Name: r.name, Category: r.stockCategory, Supplier: r.supplierName,
      'Supplier SKU': r.supplierStock, Pattern: r.bucket, Method: r.method,
      'Forecast/mo': r.monthlyForecast, 'On hand': r.onHand, 'On order': r.onOrder,
      Allocated: r.allocated, Backordered: r.backordered, Position: r.position,
      'Lead days': r.leadTimeDays, 'Safety stock': r.safetyStock, 'Reorder point': r.reorderPoint,
      'Cover (months)': r.coverMonths >= 900 ? '' : r.coverMonths,
      'Arrow min': r.arrowMinimumQty, 'Arrow reorder': r.arrowReorderQty,
      'Suggested buy': r.suggestedQty, 'Avg cost': r.avgCost, 'Buy value': r.suggestedValue,
      'Backtest WMAPE%': r.wmape, Bias: r.bias,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Forecast');
    XLSX.writeFile(wb, `hayward-forecast-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const s = data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-deep flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-wave" /> Demand forecast
          </h1>
          <p className="text-sm text-ink/50 mt-1">
            Seasonal demand and replenishment suggestions across 1-MEL &amp; 2-MEL.
            {data?.meta && (
              <> Built {new Date(data.meta.generatedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' })}
                {' · '}{data.meta.historyMonths}m history → {data.meta.horizonMonths}m ahead
                {' · '}{data.meta.serviceLevelPct}% service.</>
            )}
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
          <StatCard icon={AlertTriangle} tone="text-amber" label="Need reorder" value={NUM(s.needReorder)} sub={`of ${NUM(s.totalSkus)} SKUs`} />
          <StatCard icon={Clock} tone="text-coral" label="Stockout risk" value={NUM(s.stockoutRisk)} sub="under 1 month cover" />
          <StatCard icon={DollarSign} tone="text-wave" label="Suggested buy" value={AUD(s.totalSuggestedValue)} sub="at official cost" />
          <StatCard icon={PackageX} tone="text-ink/40" label="Dead stock" value={NUM(s.deadStock)} sub="on hand, no demand" />
        </div>
      )}

      {/* controls */}
      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-ink/40"><ListFilter className="h-4 w-4" /></div>
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink">
          <option value="">All suppliers</option>
          {data?.suppliers.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink">
          <option value="">All categories</option>
          {data?.categories.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select value={bucket} onChange={(e) => setBucket(e.target.value)} className="text-sm rounded-lg border border-ink/15 px-2.5 py-1.5 bg-white text-ink">
          <option value="">All patterns</option>
          <option value="smooth">Smooth</option>
          <option value="erratic">Erratic</option>
          <option value="intermittent">Intermittent</option>
          <option value="lumpy">Lumpy</option>
          <option value="dead">Dead</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-ink/70 cursor-pointer select-none">
          <input type="checkbox" checked={needReorder} onChange={(e) => setNeedReorder(e.target.checked)} className="rounded border-ink/30 text-wave focus:ring-wave" />
          Below reorder only
        </label>

        <div className="ml-auto flex items-center rounded-lg border border-ink/15 overflow-hidden">
          <button onClick={() => setView('list')} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 ${view === 'list' ? 'bg-wave/10 text-wave' : 'text-ink/50'}`}>
            <Boxes className="h-4 w-4" /> List
          </button>
          <button onClick={() => setView('suppliers')} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 ${view === 'suppliers' ? 'bg-wave/10 text-wave' : 'text-ink/50'}`}>
            <Container className="h-4 w-4" /> Containers
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20 text-ink/40">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {error && (
        <div className="rounded-2xl bg-white border border-coral/30 shadow-soft px-5 py-4 text-sm text-coral">
          {error}
        </div>
      )}

      {!loading && !error && data && view === 'list' && (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden divide-y divide-ink/5">
          {data.records.length === 0 ? (
            <p className="text-sm text-ink/50 px-5 py-10 text-center">No SKUs match these filters.</p>
          ) : (
            data.records.slice(0, 300).map((r) => <Row key={r.sku} r={r} />)
          )}
          {data.records.length > 300 && (
            <p className="text-[11px] text-ink/40 px-5 py-3 text-center">
              Showing the 300 most urgent of {NUM(data.records.length)} — narrow with filters or use Export for the full set.
            </p>
          )}
        </div>
      )}

      {!loading && !error && data && view === 'suppliers' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-ink/60">
            <span>Container target</span>
            <input
              type="number" value={containerTarget}
              onChange={(e) => setContainerTarget(Number(e.target.value) || 0)}
              className="w-28 rounded-lg border border-ink/15 px-2.5 py-1.5 text-ink tabular-nums"
            />
            <span className="text-ink/40">AUD at cost — bars fill as a supplier's suggested buys reach it.</span>
          </div>
          <SupplierGroups records={data.records} target={containerTarget} />
        </div>
      )}
    </div>
  );
}
