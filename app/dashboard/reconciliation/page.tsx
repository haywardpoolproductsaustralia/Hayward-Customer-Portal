'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Anchor, AlertTriangle, Search, ArrowUpDown } from 'lucide-react';
import type { ReconResponse } from '@/app/api/reconciliation/route';
import type { ReconLine } from '@/lib/recon/reconcile';
import As400Upload from './As400Upload';

type Head = ReconLine['head'];
type FilterKey = 'all' | 'exceptions' | 'transit' | 'delivered' | 'pending' | 'not_received';

const HEAD_META: Record<Head, { label: string; chip: string }> = {
  matched:             { label: 'Matched',       chip: 'bg-splash/10 text-splash' },
  delivered:           { label: 'Delivered',     chip: 'bg-splash/10 text-splash' },
  qty_mismatch:        { label: 'Qty mismatch',  chip: 'bg-amber/10 text-amber'   },
  missing_at_supplier: { label: 'Missing',       chip: 'bg-coral/10 text-coral'   },
  cancelled:           { label: 'Cancelled',     chip: 'bg-coral/10 text-coral'   },
  in_transit:          { label: 'In transit',    chip: 'bg-wave/10 text-wave'     },
  awaiting_shipment:   { label: 'Awaiting ship', chip: 'bg-ink/10 text-ink/50'    },
};

const fmt = (s: string | null) =>
  !s ? '—' : new Date(s + 'T00:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit' });
const qty = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString());

const onWater = (r: ReconLine) => {
  if (!r.shipment) return 0;
  const u = r.shipment.units ?? 0;
  const d = r.shipment.delivered ? (r.shipment.units ?? 0) : 0;
  return Math.max(0, u - d);
};

type SortKey = 'po' | 'arrowStock' | 'orderDate' | 'supplier' | 'status';

export default function ReconciliationPage() {
  const [data, setData] = useState<ReconResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'po', dir: -1 });

  useEffect(() => {
    fetch('/api/reconciliation')
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const rows = useMemo(() => {
    let out = (data?.lines ?? []).filter((r) => {
      if (filter === 'exceptions' && !(r.head === 'missing_at_supplier' || r.head === 'cancelled' || r.head === 'qty_mismatch')) return false;
      if (filter === 'transit' && r.head !== 'in_transit') return false;
      if (filter === 'delivered' && r.head !== 'delivered') return false;
      if (filter === 'pending' && r.head !== 'awaiting_shipment') return false;
      if (filter === 'not_received' && r.received) return false;
      if (q && !`${r.po} ${r.arrowStock} ${r.supplierSku} ${r.supplier}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    const val = (r: ReconLine): string | number =>
      sort.key === 'status' ? r.head : ((r[sort.key] as string) ?? '');
    out = [...out].sort((a, b) => {
      const av = val(a), bv = val(b);
      return av < bv ? -sort.dir : av > bv ? sort.dir : 0;
    });
    return out;
  }, [data, filter, q, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((st) => (st.key === key ? { key, dir: (st.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const chip = (id: FilterKey, label: string, active: string) => (
    <button onClick={() => setFilter(id)}
      className={`px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${filter === id ? active : 'border-ink/10 text-ink/60 hover:bg-ink/5'}`}>
      {label}
    </button>
  );

  const Th = ({ label, k, right }: { label: string; k?: SortKey; right?: boolean }) => (
    <th className={`sticky top-0 z-10 bg-ink text-white text-[11px] font-semibold uppercase tracking-wide px-2.5 py-2 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
      {k ? (
        <button onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-white/80">
          {label}<ArrowUpDown className="h-3 w-3 opacity-60" />
        </button>
      ) : label}
    </th>
  );

  if (error) {
    return (
      <div className="rounded-2xl bg-white border border-coral/20 shadow-soft px-5 py-4 flex items-center gap-3">
        <AlertTriangle className="h-5 w-5 text-coral flex-shrink-0" />
        <p className="text-sm text-ink/70">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="flex items-center gap-2 text-ink/50 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading reconciliation…</div>;

  const s = data.summary;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-display font-semibold text-deep">
            <Anchor className="h-6 w-6 text-wave" /> Order Reconciliation &amp; ETA
          </h1>
          <p className="text-sm text-ink/50 mt-1">Arrow POs vs. AS400 supplier entry vs. CDS-Net shipment portal · Australia &amp; New Zealand</p>
        </div>
        <div className="text-right text-[11px] text-ink/40 leading-relaxed">
          <div>shipment file · {fmt(data.meta.shipmentReceivedAt?.slice(0, 10) ?? null)}</div>
          <div>{data.meta.arrowLines} Arrow · {data.meta.as400Rows} AS400 · {data.meta.shipmentRows} shipment</div>
        </div>
      </div>

      <As400Upload uploadedAt={data.meta.as400UploadedAt} rows={data.meta.as400Rows} />

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {([
          ['PO lines', s.total, 'text-ink'],
          ['Exceptions', s.exceptions, 'text-amber'],
          ['In transit', s.inTransit, 'text-wave'],
          ['Delivered', s.delivered, 'text-splash'],
          ['Late vs. request', s.late, 'text-coral'],
        ] as [string, number, string][]).map(([label, value, tone]) => (
          <div key={label} className="rounded-2xl bg-white border border-ink/10 shadow-soft px-5 py-4">
            <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
            <div className="text-[11px] uppercase tracking-wide text-ink/50 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 rounded-lg border border-ink/10 bg-white px-3 py-2 flex-1 max-w-xs">
          <Search className="h-4 w-4 text-ink/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PO, SKU, supplier…"
            className="w-full bg-transparent text-sm outline-none text-ink placeholder:text-ink/30" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {chip('all', 'All', 'border-wave bg-wave/10 text-wave')}
          {chip('exceptions', 'Exceptions', 'border-amber bg-amber/10 text-amber')}
          {chip('not_received', 'Not received', 'border-sunset bg-sunset/10 text-sunset')}
          {chip('transit', 'In transit', 'border-wave bg-wave/10 text-wave')}
          {chip('delivered', 'Delivered', 'border-splash bg-splash/10 text-splash')}
          {chip('pending', 'Awaiting ship', 'border-ink/20 bg-ink/5 text-ink/60')}
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <Th label="" />
                <Th label="Stock code" k="arrowStock" />
                <Th label="Supplier SKU" />
                <Th label="PO" k="po" />
                <Th label="Ordered" k="orderDate" />
                <Th label="ETA Arrow" />
                <Th label="Ord" right /><Th label="Rcvd" right />
                <Th label="AS400 Ent" right /><Th label="AS400 Shpd" right />
                <Th label="On Water" right /><Th label="Container ETA" />
                <Th label="Supplier" k="supplier" />
                <Th label="Status" k="status" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={14} className="text-center text-sm text-ink/40 py-12">No lines match this filter.</td></tr>
              )}
              {rows.map((r, i) => {
                const hm = HEAD_META[r.head];
                const water = onWater(r);
                const asIn = r.as400 != null;
                return (
                  <tr key={`${r.po}-${r.line}-${r.arrowStock}`} className={i % 2 ? 'bg-foam/40' : ''}>
                    <td className={`w-1.5 p-0 ${!r.received ? 'bg-sunset' : r.qtyOutstanding > 0 ? 'bg-amber/60' : 'bg-splash'}`} />
                    <td className="px-2.5 py-1.5 font-mono font-semibold text-ink whitespace-nowrap">{r.arrowStock}</td>
                    <td className="px-2.5 py-1.5 font-mono text-ink/70 whitespace-nowrap">{r.supplierSku || '—'}</td>
                    <td className="px-2.5 py-1.5 font-mono font-semibold text-wave">{r.po}</td>
                    <td className="px-2.5 py-1.5 text-ink/60 whitespace-nowrap">{fmt(r.orderDate)}</td>
                    <td className="px-2.5 py-1.5 text-ink/60 whitespace-nowrap">{fmt(r.requestedDate)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-ink">{qty(r.qtyOrdered)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-ink/60">{qty(r.qtyReceived)}</td>
                    <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${asIn ? 'bg-splash/10 text-splash' : 'text-coral/70'}`}>{asIn ? qty(r.as400!.orderedQty) : 'missing'}</td>
                    <td className={`px-2.5 py-1.5 text-right tabular-nums ${asIn ? 'bg-splash/10 text-splash' : ''}`}>{asIn ? qty(r.as400!.shippedQty) : ''}</td>
                    <td className={`px-2.5 py-1.5 text-right tabular-nums ${water > 0 ? 'bg-wave/10 text-wave font-medium' : 'text-ink/30'}`}>{water > 0 ? qty(water) : '—'}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap text-ink/60">{fmt(r.shipment?.eta ?? null)}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap text-ink/70">{r.supplier || '—'}</td>
                    <td className="px-2.5 py-1.5"><span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${hm.chip}`}>{hm.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-4 text-[11px] text-ink/40 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 rounded-sm bg-sunset" /> Not received in Arrow</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 rounded-sm bg-amber/60" /> Partially received</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 rounded-sm bg-splash/20" /> AS400 has the line</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2.5 rounded-sm bg-wave/20" /> On the water</span>
      </div>
    </div>
  );
}
