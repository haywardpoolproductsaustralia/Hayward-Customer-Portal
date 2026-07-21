'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, Anchor, Package, Ship, Database, AlertTriangle, CheckCircle2, XCircle,
  CircleDashed, Search, ChevronDown, ChevronRight,
} from 'lucide-react';
import type { ReconResponse } from '@/app/api/reconciliation/route';
import type { ReconLine } from '@/lib/recon/reconcile';

type Head = ReconLine['head'];

const HEAD_META: Record<Head, { label: string; chip: string; dot: string }> = {
  matched:             { label: 'Matched',             chip: 'bg-splash/10 text-splash', dot: 'bg-splash' },
  delivered:           { label: 'Delivered',           chip: 'bg-splash/10 text-splash', dot: 'bg-splash' },
  qty_mismatch:        { label: 'Qty mismatch',        chip: 'bg-amber/10 text-amber',   dot: 'bg-amber'  },
  missing_at_supplier: { label: 'Missing at supplier', chip: 'bg-coral/10 text-coral',   dot: 'bg-coral'  },
  cancelled:           { label: 'Cancelled',           chip: 'bg-coral/10 text-coral',   dot: 'bg-coral'  },
  in_transit:          { label: 'In transit',          chip: 'bg-wave/10 text-wave',     dot: 'bg-wave'   },
  awaiting_shipment:   { label: 'Awaiting shipment',   chip: 'bg-ink/10 text-ink/50',    dot: 'bg-ink/40' },
};

const fmtDate = (s: string | null) =>
  !s ? '—' : new Date(s + 'T00:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });

type FilterKey = 'all' | 'exceptions' | 'transit' | 'delivered' | 'pending';

/* three-lane flow: Arrow -> AS400 -> Shipment, coloured by where it stands */
function FlowTrack({ r }: { r: ReconLine }) {
  const broke = !r.as400 || r.head === 'cancelled';
  const asColor = broke ? 'text-coral border-coral' : r.head === 'qty_mismatch' ? 'text-amber border-amber' : 'text-splash border-splash';
  const shDelivered = !!r.shipment?.delivered;
  const shTransit = !shDelivered && !!r.shipment?.eta;
  const shColor = shDelivered ? 'text-splash border-splash' : shTransit ? 'text-wave border-wave' : 'text-ink/30 border-ink/20';
  const node = (border: string, filled: boolean, fillClass: string, icon: React.ReactNode) => (
    <span className={`grid place-items-center h-6 w-6 rounded-full border ${border} ${filled ? `${fillClass} text-white` : 'bg-white'}`}>{icon}</span>
  );
  const conn = (cls: string) => <span className={`h-px w-4 sm:w-6 ${cls}`} />;
  return (
    <div className="flex items-center gap-1">
      {node('border-wave', true, 'bg-wave', <Package className="h-3.5 w-3.5" />)}
      {conn(broke ? 'bg-coral/40' : 'bg-wave/40')}
      {node(asColor, !broke, broke ? 'bg-coral' : r.head === 'qty_mismatch' ? 'bg-amber' : 'bg-splash',
        broke ? <XCircle className="h-3.5 w-3.5" /> : r.head === 'qty_mismatch' ? <AlertTriangle className="h-3.5 w-3.5" /> : <Database className="h-3.5 w-3.5" />)}
      {conn(broke ? 'bg-ink/10' : shDelivered ? 'bg-splash/40' : shTransit ? 'bg-wave/40' : 'bg-ink/10')}
      {node(shColor, shDelivered || shTransit, shDelivered ? 'bg-splash' : 'bg-wave',
        shDelivered ? <CheckCircle2 className="h-3.5 w-3.5" /> : shTransit ? <Ship className="h-3.5 w-3.5" /> : <CircleDashed className="h-3.5 w-3.5" />)}
    </div>
  );
}

function DetailCol({ title, tone, rows }: { title: string; tone: string; rows: [string, string][] }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-foam/60 p-3">
      <div className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${tone}`}>{title}</div>
      <dl className="space-y-1">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex justify-between gap-3 text-[13px]">
            <dt className="text-ink/50">{k}</dt>
            <dd className="text-ink font-mono text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LineRow({ r }: { r: ReconLine }) {
  const [open, setOpen] = useState(false);
  const hm = HEAD_META[r.head];
  const etaTone = r.etaKind === 'delivered' ? 'text-splash' : r.etaKind === 'container_eta' ? 'text-wave' : 'text-ink/60';
  const etaLabel = r.etaKind === 'delivered' ? 'delivered' : r.etaKind === 'container_eta' ? 'container ETA' : r.etaKind === 'supplier_promise' ? 'supplier promise' : 'no date';
  return (
    <div className="border-t border-ink/5">
      <button onClick={() => setOpen((o) => !o)} className="w-full grid grid-cols-[16px_130px_1fr_150px_140px] gap-3 items-center px-4 py-3 text-left hover:bg-foam/50">
        <span className="text-ink/30">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
        <span>
          <span className="block font-mono text-[13px] font-semibold text-ink">{r.arrowStock}</span>
          <span className="block text-[11px] text-ink/40">{r.supplierSku || 'no supplier sku'}</span>
        </span>
        <FlowTrack r={r} />
        <span><span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${hm.chip}`}>{hm.label}</span></span>
        <span className="text-right">
          <span className={`block font-mono text-[13px] ${etaTone}`}>{fmtDate(r.eta)}</span>
          <span className="block text-[10px] uppercase tracking-wide text-ink/40">
            {etaLabel}{r.daysLate != null && r.daysLate > 0 ? ` · ${r.daysLate}d late` : ''}
          </span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pl-11 grid sm:grid-cols-3 gap-3 bg-foam/30">
          <DetailCol title="Arrow (ordered)" tone="text-wave" rows={[
            ['Stock code', r.arrowStock], ['Supplier SKU', r.supplierSku || '—'], ['Qty ordered', String(r.qtyOrdered)],
          ]} />
          <DetailCol title="AS400 (supplier entry)" tone={r.as400 ? (r.head === 'qty_mismatch' ? 'text-amber' : 'text-splash') : 'text-coral'}
            rows={r.as400 ? [
              ['Qty entered', String(r.as400.orderedQty)], ['Qty shipped', String(r.as400.shippedQty)],
              ['Promise date', fmtDate(r.as400.promiseDate)], ['US sales order', r.as400.usSalesOrder ?? '—'],
              ['Cancelled', r.as400.anyCancelled ? 'YES' : 'no'],
            ] : [['Status', 'Never entered into the supplier system']]} />
          <DetailCol title="Shipment portal" tone={r.shipment ? (r.shipment.delivered ? 'text-splash' : 'text-wave') : 'text-ink/40'}
            rows={r.shipment ? [
              ['Container', r.shipment.container ?? '—'], ['Vessel', r.shipment.vessel ?? '—'],
              ['ETD → ETA', `${fmtDate(r.shipment.etd)} → ${fmtDate(r.shipment.eta)}`],
              ['Delivered', fmtDate(r.shipment.delivered)],
              ['Route', `${r.shipment.origin ?? '?'} → ${r.shipment.destPort ?? '?'}`],
              ...(r.shipmentCount > 1 ? ([['Other containers', `${r.shipmentCount - 1} more`]] as [string, string][]) : []),
            ] : [['Status', 'No AU/NZ container matched yet']]} />
          {r.flags.length > 0 && (
            <div className="sm:col-span-3 flex flex-wrap gap-2">
              {r.flags.map((f, i) => {
                const tone = f.severity === 'error' ? 'bg-coral/10 text-coral border-coral/30'
                  : f.severity === 'warn' ? 'bg-amber/10 text-amber border-amber/30' : 'bg-wave/10 text-wave border-wave/30';
                return (
                  <span key={i} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] ${tone}`}>
                    <AlertTriangle className="h-3 w-3" /> {f.text}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-5 py-4">
      <div className={`text-2xl font-semibold tabular-nums ${tone ?? 'text-ink'}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-ink/50 mt-0.5">{label}</div>
    </div>
  );
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ReconResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');

  useEffect(() => {
    fetch('/api/reconciliation')
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const shown = useMemo(() => {
    const lines = data?.lines ?? [];
    return lines.filter((r) => {
      if (filter === 'exceptions' && !(r.head === 'missing_at_supplier' || r.head === 'cancelled' || r.head === 'qty_mismatch')) return false;
      if (filter === 'transit' && r.head !== 'in_transit') return false;
      if (filter === 'delivered' && r.head !== 'delivered') return false;
      if (filter === 'pending' && r.head !== 'awaiting_shipment') return false;
      if (q && !`${r.po} ${r.arrowStock} ${r.supplierSku}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [data, filter, q]);

  const byPo = useMemo(() => {
    const m: Record<string, ReconLine[]> = {};
    shown.forEach((r) => { (m[r.po] = m[r.po] || []).push(r); });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  const chip = (id: FilterKey, label: string, active: string) => (
    <button onClick={() => setFilter(id)}
      className={`px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${filter === id ? active : 'border-ink/10 text-ink/60 hover:bg-ink/5'}`}>
      {label}
    </button>
  );

  if (error) {
    return (
      <div className="rounded-2xl bg-white border border-coral/20 shadow-soft px-5 py-4 flex items-center gap-3">
        <AlertTriangle className="h-5 w-5 text-coral flex-shrink-0" />
        <p className="text-sm text-ink/70">{error}</p>
      </div>
    );
  }
  if (!data) {
    return <div className="flex items-center gap-2 text-ink/50 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading reconciliation…</div>;
  }

  const s = data.summary;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-display font-semibold text-deep">
            <Anchor className="h-6 w-6 text-wave" /> Order Reconciliation & ETA
          </h1>
          <p className="text-sm text-ink/50 mt-1">Arrow POs vs. AS400 supplier entry vs. CDS-Net shipment portal · Australia & New Zealand</p>
        </div>
        <div className="text-right text-[11px] text-ink/40 leading-relaxed">
          <div>shipment file · {fmtDate(data.meta.shipmentReceivedAt?.slice(0, 10) ?? null)}</div>
          <div>{data.meta.arrowLines} Arrow · {data.meta.as400Rows} AS400 · {data.meta.shipmentRows} shipment</div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="PO lines" value={s.total} />
        <Stat label="Exceptions" value={s.exceptions} tone="text-amber" />
        <Stat label="In transit" value={s.inTransit} tone="text-wave" />
        <Stat label="Delivered" value={s.delivered} tone="text-splash" />
        <Stat label="Late vs. request" value={s.late} tone="text-coral" />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 rounded-lg border border-ink/10 bg-white px-3 py-2 flex-1 max-w-xs">
          <Search className="h-4 w-4 text-ink/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PO or SKU…"
            className="w-full bg-transparent text-sm outline-none text-ink placeholder:text-ink/30" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {chip('all', 'All', 'border-wave bg-wave/10 text-wave')}
          {chip('exceptions', 'Exceptions', 'border-amber bg-amber/10 text-amber')}
          {chip('transit', 'In transit', 'border-wave bg-wave/10 text-wave')}
          {chip('delivered', 'Delivered', 'border-splash bg-splash/10 text-splash')}
          {chip('pending', 'Awaiting ship', 'border-ink/20 bg-ink/5 text-ink/60')}
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
        {byPo.length === 0 && <div className="px-5 py-12 text-center text-sm text-ink/40">No lines match this filter.</div>}
        {byPo.map(([po, rows]) => (
          <div key={po}>
            <div className="flex items-center justify-between px-4 py-2.5 bg-foam/70 border-y border-ink/5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-ink/40">PO</span>
                <span className="font-mono text-[15px] font-semibold text-wave">{po}</span>
              </div>
              <span className="text-[11px] text-ink/50">{rows.length} line{rows.length > 1 ? 's' : ''}</span>
            </div>
            {rows.map((r) => <LineRow key={`${po}-${r.line}-${r.arrowStock}`} r={r} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
