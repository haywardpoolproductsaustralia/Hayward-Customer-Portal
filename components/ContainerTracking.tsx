'use client';

// components/ContainerTracking.tsx
// The tracking panel that opens under a Purchasing row, plus the helpers the page uses to fold
// container-store data (ShipsGo live + CDS + supplier PDFs) into its existing reconcile().
// Data: GET /api/containers/view → { containers: CtContainer[] }.

import { useState } from 'react';

export type CtLine = { po: string; item: string; qty: number; source: string; ref: string };
export type CtMovement = { event: string; status: 'ACT' | 'EST'; location?: string; vessel?: string; voyage?: string; timestamp: string };
export type CtLive = {
  shipmentId: number; reference?: string; shipmentStatus?: string; containerStatus?: string;
  carrier?: string; carrierScac?: string; pol?: string; pod?: string; etd?: string; eta?: string; etaInitial?: string;
  etaPredicted?: string; mapUrl?: string;
  previousEta?: string; etaChangedAt?: string; vessel?: string; voyage?: string; transitPercentage?: number;
  movements: CtMovement[]; checkedAt?: string; updatedAt: string;
};
export type CtCentury = { event?: string; status?: string; eventAt?: string; vesselArrivedAt?: string; currentEta?: string; forwarder?: string; updatedAt: string };
export type CtContainer = {
  containerNo: string; pos: string[]; lines: CtLine[]; sources: string[]; firstSeen: string; lastSeen: string;
  mbl?: string; hbl?: string; forwarder?: string; vendor?: string; originPort?: string; destPort?: string; shipMode?: 'O' | 'A';
  vessel?: string; voyage?: string; etd?: string; eta?: string; deliveredDate?: string; size?: string; shipKey?: string;
  invoiceNos?: string[]; packingSlipNos?: string[]; live?: CtLive; century?: CtCentury;
  registration?: { shipmentId: number; by: string; number: string; at: string };
};

export const normKey = (v: string | null | undefined) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const lineKey = (po: string, item: string) => `${po}|${normKey(item)}`;

const EVENT_LABEL: Record<string, string> = {
  EMSH: 'Empty to shipper', GTIN: 'Gate in', LOAD: 'Loaded', DEPA: 'Departed', ARRV: 'Arrived', DISC: 'Discharged', GTOT: 'Gate out', EMRT: 'Empty returned',
};
const STATUS_LABEL: Record<string, string> = {
  EMPTY_SHIPPER: 'Empty to shipper', GATE_IN: 'At origin terminal', LOADED: 'Loaded', SAILING: 'Sailing', ARRIVED: 'Arrived', DISCHARGED: 'Discharged',
  GATE_OUT: 'Collected', EMPTY_RETURN: 'Empty returned', UNKNOWN: 'Unknown',
  NEW: 'Registered', INPROGRESS: 'Looking up', BOOKED: 'Booked', UNTRACKED: 'Untracked',
};
const SOURCE_LABEL: Record<string, string> = { shipsgo: 'ShipsGo', century: 'Century', cds: 'CDS-Net', 'wuxi-packing-slip': 'Wuxi packing slip', 'us-invoice': 'US invoice' };

export const fmtD = (d?: string | null) => {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${Number(day)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y.slice(2)}` : d;
};
const ago = (iso?: string) => {
  if (!iso) return '';
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 36e5);
  return h < 1 ? 'just now' : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** Where the box is right now, in one word, and the tone for the chip. */
export function ctStatus(c: CtContainer): { label: string; tone: 'done' | 'live' | 'doc' | 'wait'; closed: boolean } {
  const s = c.live?.containerStatus;
  if (s === 'GATE_OUT' || s === 'EMPTY_RETURN' || c.deliveredDate) return { label: s ? STATUS_LABEL[s] : `Delivered ${fmtD(c.deliveredDate)}`, tone: 'done', closed: true };
  if (s && s !== 'UNKNOWN') return { label: STATUS_LABEL[s] ?? s, tone: 'live', closed: false };
  if (c.live?.shipmentStatus) return { label: STATUS_LABEL[c.live.shipmentStatus] ?? c.live.shipmentStatus, tone: 'live', closed: false };
  const cs = c.century?.status;
  if (cs === 'GATE_OUT' || cs === 'EMPTY_RETURN') return { label: `${STATUS_LABEL[cs]} ${fmtD(c.century?.eventAt)}`, tone: 'done', closed: true };
  if (cs) return { label: `${STATUS_LABEL[cs] ?? c.century?.event} (Century)`, tone: 'live', closed: false };
  if (c.eta || c.vessel) return { label: 'On water (CDS)', tone: 'doc', closed: false };
  return { label: 'Shipped — awaiting vessel', tone: 'wait', closed: false };
}
export const bestEta = (c: CtContainer) => c.live?.eta ?? c.century?.currentEta ?? c.eta ?? null;
export const bestVessel = (c: CtContainer) => c.live?.vessel ?? c.vessel ?? null;
export const bestCarrier = (c: CtContainer) => c.live?.carrier ?? c.live?.carrierScac ?? c.forwarder ?? null;

/** Delivered date for the page's status logic: the ACT gate-out movement, else CDS. */
export function deliveredOf(c: CtContainer): string | null {
  const m = [...(c.live?.movements ?? [])].reverse().find((x) => x.status === 'ACT' && (x.event === 'GTOT' || x.event === 'EMRT'));
  if (m) return m.timestamp.slice(0, 10);
  if (c.century?.status && (c.century.status === 'GATE_OUT' || c.century.status === 'EMPTY_RETURN')) return c.century.eventAt ?? c.deliveredDate ?? null;
  return c.deliveredDate ?? null;
}

/** Index containers by PO line and by PO (for ShipsGo-only boxes whose items we don't know). */
export function indexContainers(cs: CtContainer[]) {
  const byLine = new Map<string, CtContainer[]>();
  const byPo = new Map<string, CtContainer[]>();
  for (const c of cs) {
    const seenLine = new Set<string>();
    for (const l of c.lines) {
      const k = lineKey(l.po, l.item ?? (l as any).supplierItem);
      if (seenLine.has(k)) continue;
      seenLine.add(k);
      (byLine.get(k) ?? byLine.set(k, []).get(k)!).push(c);
    }
    for (const po of c.pos) (byPo.get(po) ?? byPo.set(po, []).get(po)!).push(c);
  }
  return { byLine, byPo };
}

/** Qty of this PO line inside the container — CDS count wins over the supplier PDF (CDS is the forwarder's load list). */
export function qtyInContainer(c: CtContainer, po: string, item: string): number | null {
  const ls = c.lines.filter((l) => l.po === po && normKey(l.item ?? (l as any).supplierItem) === normKey(item));
  if (!ls.length) return null;
  const pri: Record<string, number> = { century: 4, cds: 3, 'wuxi-packing-slip': 2, 'us-invoice': 1 };
  return [...ls].sort((a, b) => (pri[b.source] ?? 0) - (pri[a.source] ?? 0))[0].qty;
}

const toneCls: Record<string, string> = {
  done: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  live: 'bg-sky-50 text-sky-800 border-sky-200',
  doc: 'bg-violet-50 text-violet-800 border-violet-200',
  wait: 'bg-amber-50 text-amber-800 border-amber-200',
};

export function StatusChip({ c }: { c: CtContainer }) {
  const s = ctStatus(c);
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${toneCls[s.tone]}`}>{s.label}</span>;
}

function EtaCell({ c }: { c: CtContainer }) {
  const eta = bestEta(c);
  const prev = c.live?.previousEta ?? (c.live?.etaInitial && c.live.etaInitial !== c.live.eta ? c.live.etaInitial : undefined);
  const slipped = prev && eta && prev < eta, early = prev && eta && prev > eta;
  return (
    <span>
      <b>{fmtD(eta)}</b>
      {slipped && <span className="ml-1 text-rose-600" title={`ETA moved later (was ${fmtD(prev)})`}>▲ was {fmtD(prev)}</span>}
      {early && <span className="ml-1 text-emerald-600" title={`ETA moved earlier (was ${fmtD(prev)})`}>▼ was {fmtD(prev)}</span>}
      {!c.live?.eta && c.century?.currentEta && <span className="ml-1 text-slate-400">(Century)</span>}
      {!c.live?.eta && !c.century?.currentEta && c.eta && <span className="ml-1 text-slate-400">(CDS)</span>}
      {c.live?.etaPredicted && c.live.etaPredicted !== eta && <span className="ml-1 text-slate-500" title="ShipsGo's ETA-prediction model (carrier ETAs often lag reality)">· predicted {fmtD(c.live.etaPredicted)}</span>}
    </span>
  );
}

function ContainerCard({ c, po, item, poOnly }: { c: CtContainer; po: string; item: string; poOnly?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const qty = qtyInContainer(c, po, item);
  const movements = c.live?.movements ?? [];
  const acts = movements.filter((m) => m.status === 'ACT');
  const ests = movements.filter((m) => m.status === 'EST');
  const shown = showAll ? movements : [...acts.slice(-3), ...ests.slice(0, 2)];
  const otherPos = c.pos.filter((p) => p !== po);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-bold text-slate-900">{c.containerNo}</span>
        {c.size && <span className="text-slate-400">{c.size}</span>}
        <StatusChip c={c} />
        {qty != null
          ? <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">× {qty} of this line</span>
          : poOnly && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800" title="ShipsGo reference names this PO but no document has confirmed which items are inside">PO-level — items not confirmed</span>}
        {c.live?.transitPercentage != null && !ctStatus(c).closed && (
          <span className="ml-auto flex items-center gap-1 text-slate-500" title="Transit progress (ShipsGo)">
            <span className="inline-block h-1.5 w-20 overflow-hidden rounded bg-slate-200"><span className="block h-full bg-sky-500" style={{ width: `${Math.min(100, c.live.transitPercentage)}%` }} /></span>
            {c.live.transitPercentage}%
          </span>
        )}
      </div>

      <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        <div><span className="text-slate-400">Route</span><br />{c.live?.pol ?? c.originPort ?? '—'} → {c.live?.pod ?? c.destPort ?? '—'}</div>
        <div><span className="text-slate-400">ETD / ETA</span><br />{fmtD(c.live?.etd ?? c.etd)} → <EtaCell c={c} /></div>
        <div><span className="text-slate-400">Vessel</span><br />{bestVessel(c) ?? '—'}{(c.live?.voyage ?? c.voyage) && <span className="text-slate-500"> · {c.live?.voyage ?? c.voyage}</span>}</div>
        <div><span className="text-slate-400">Carrier</span><br />{bestCarrier(c) ?? '—'}{c.forwarder && c.live?.carrier && <span className="text-slate-500"> · via {c.forwarder}</span>}</div>
      </div>

      {!shown.length && c.century?.event && (
        <div className="mt-2 border-t border-slate-100 pt-2 text-slate-700">
          <span className="text-emerald-600">●</span> <b>{c.century.event}</b> <span className="text-slate-400">{fmtD(c.century.eventAt)}</span>
          {c.century.vesselArrivedAt && <span className="text-slate-500"> · vessel arrived {fmtD(c.century.vesselArrivedAt)}</span>}
          <span className="text-slate-400"> (Century)</span>
        </div>
      )}
      {shown.length > 0 && (
        <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2">
          {shown.map((m, i) => (
            <li key={i} className={m.status === 'ACT' ? 'text-slate-800' : 'text-slate-400'}>
              <span className={m.status === 'ACT' ? 'text-emerald-600' : 'text-slate-300'}>{m.status === 'ACT' ? '●' : '○'}</span>{' '}
              <b>{EVENT_LABEL[m.event] ?? m.event}</b> {m.location && <span>{m.location}</span>} <span className="text-slate-400">{fmtD(m.timestamp)}</span>
              {m.vessel && <span className="text-slate-400"> · {m.vessel}</span>}
            </li>
          ))}
          {movements.length > shown.length && <li><button className="text-sky-700 underline" onClick={() => setShowAll(true)}>all {movements.length} events</button></li>}
        </ol>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
        <span>Sources: {c.sources.map((s) => SOURCE_LABEL[s] ?? s).join(' · ')}</span>
        {c.mbl && <span>MBL <span className="font-mono">{c.mbl}</span></span>}
        {c.invoiceNos?.length ? <span>Inv {c.invoiceNos.join(', ')}</span> : null}
        {c.packingSlipNos?.length ? <span>Slip {c.packingSlipNos.join(', ')}</span> : null}
        {otherPos.length > 0 && <span>Also POs {otherPos.join(', ')}</span>}
        {c.shipKey && <a className="text-sky-700 underline" href={`https://centuryvms.com/ui/container/view/${c.shipKey}/${c.containerNo}`} target="_blank" rel="noreferrer">Century ↗</a>}
        {c.live && <a className="text-sky-700 underline" href={c.live.mapUrl ?? 'https://shipsgo.com/dashboard/track-and-trace/my-shipments'} target="_blank" rel="noreferrer">{c.live.mapUrl ? 'Live map ↗' : 'ShipsGo ↗'}</a>}
        <span className="ml-auto">{c.live ? `ShipsGo checked ${ago(c.live.checkedAt ?? c.live.updatedAt)}` : `last document ${ago(c.lastSeen)}`}</span>
      </div>
    </div>
  );
}

/** The expandable panel rendered under a Purchasing row. */
export function TrackingPanel({ po, item, lineContainers, poContainers }: { po: string; item: string; lineContainers: CtContainer[]; poContainers: CtContainer[] }) {
  const lineNos = new Set(lineContainers.map((c) => c.containerNo));
  const extra = poContainers.filter((c) => !lineNos.has(c.containerNo));
  if (!lineContainers.length && !extra.length) {
    return <div className="px-3 py-2 text-xs text-slate-500">No container document or ShipsGo shipment mentions PO {po} yet.</div>;
  }
  return (
    <div className="space-y-2 px-3 py-2">
      {lineContainers.map((c) => <ContainerCard key={c.containerNo} c={c} po={po} item={item} />)}
      {extra.length > 0 && (
        <details className="text-xs" open={!lineContainers.length}>
          <summary className="cursor-pointer text-slate-500">{extra.length} more container{extra.length > 1 ? 's' : ''} on PO {po} (other items, or item not confirmed)</summary>
          <div className="mt-2 space-y-2">{extra.map((c) => <ContainerCard key={c.containerNo} c={c} po={po} item={item} poOnly />)}</div>
        </details>
      )}
    </div>
  );
}
