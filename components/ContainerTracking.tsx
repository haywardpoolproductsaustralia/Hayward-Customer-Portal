'use client';


// components/ContainerTracking.tsx
// The tracking panel that opens under a Purchasing row, plus the helpers the page uses to fold
// container-store data (ShipsGo live + CDS + supplier PDFs) into its existing reconcile().
// Data: GET /api/containers/view → { containers: CtContainer[] }.


export type CtLine = { po: string; item: string; qty: number; source: string; ref: string };
export type CtMovement = { event: string; status: 'ACT' | 'EST'; location?: string; vessel?: string; voyage?: string; timestamp: string };
export type CtLive = {
  shipmentId: number; reference?: string; shipmentStatus?: string; containerStatus?: string;
  carrier?: string; carrierScac?: string; pol?: string; pod?: string; etd?: string; eta?: string; etaInitial?: string;
  etaPredicted?: string; mapUrl?: string;
  previousEta?: string; etaChangedAt?: string; vessel?: string; voyage?: string; transitPercentage?: number;
  movements: CtMovement[]; checkedAt?: string; updatedAt: string;
};
export type CtChr = { shipmentNo: string; reference?: string; statusRaw: string; status?: string; etd?: string; atd?: string; eta?: string; ata?: string; pickedUpAt?: string; deliverEta?: string; deliveredAt?: string; carrier?: string; usOrigin: boolean; updatedAt: string };
export type CtSchedule = { supplier?: string; forwarder?: string; dispatched?: string; eta?: string; revisedDelivery?: string; note?: string; location?: string; items?: string; invoiceNos: string[]; sheet: string; updatedAt: string };
export type CtCentury = { event?: string; status?: string; eventAt?: string; vesselArrivedAt?: string; currentEta?: string; forwarder?: string; updatedAt: string };
export type CtContainer = {
  containerNo: string; pos: string[]; lines: CtLine[]; sources: string[]; firstSeen: string; lastSeen: string;
  mbl?: string; hbl?: string; forwarder?: string; vendor?: string; originPort?: string; destPort?: string; shipMode?: 'O' | 'A';
  vessel?: string; voyage?: string; etd?: string; eta?: string; deliveredDate?: string; size?: string; shipKey?: string;
  invoiceNos?: string[]; packingSlipNos?: string[]; live?: CtLive; century?: CtCentury; chr?: CtChr; schedule?: CtSchedule;
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
const SOURCE_LABEL: Record<string, string> = { shipsgo: 'ShipsGo', century: 'Century', chr: 'C.H. Robinson', cds: 'CDS-Net', schedule: "Dimi's schedule", 'wuxi-packing-slip': 'Wuxi packing slip', 'us-invoice': 'US invoice' };

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
  const pending = !c.live?.shipmentStatus || ['NEW', 'INPROGRESS', 'UNTRACKED'].includes(c.live.shipmentStatus);
  if (c.live?.shipmentStatus && !pending) return { label: STATUS_LABEL[c.live.shipmentStatus] ?? c.live.shipmentStatus, tone: 'live', closed: false };
  // ShipsGo hasn't got data yet — fall through to the forwarder feeds, and only then show "Looking up"
  const cs = c.century?.status;
  if (cs === 'GATE_OUT' || cs === 'EMPTY_RETURN') return { label: `${STATUS_LABEL[cs]} ${fmtD(c.century?.eventAt)}`, tone: 'done', closed: true };
  if (cs) return { label: `${STATUS_LABEL[cs] ?? c.century?.event} (Century)`, tone: 'live', closed: false };
  const hs = c.chr?.status;
  if (hs === 'GATE_OUT' || hs === 'EMPTY_RETURN') return { label: `${STATUS_LABEL[hs]} ${fmtD(c.chr?.deliveredAt ?? c.chr?.ata)}`, tone: 'done', closed: true };
  if (hs) return { label: `${STATUS_LABEL[hs] ?? c.chr?.statusRaw} (CHR)`, tone: 'live', closed: false };
  if (c.live?.shipmentStatus) return { label: STATUS_LABEL[c.live.shipmentStatus] ?? c.live.shipmentStatus, tone: 'wait', closed: false };
  if ((c.eta || c.vessel) && c.sources.includes('cds')) return { label: 'On water (CDS)', tone: 'doc', closed: false };
  if (c.eta || c.schedule?.eta) return { label: "On water (Dimi's schedule)", tone: 'doc', closed: false };
  return { label: 'Shipped — awaiting vessel', tone: 'wait', closed: false };
}
export const bestEta = (c: CtContainer) => c.live?.eta ?? c.century?.currentEta ?? c.chr?.eta ?? c.eta ?? c.schedule?.eta ?? null;
export const bestVessel = (c: CtContainer) => c.live?.vessel ?? c.vessel ?? null;
export const bestCarrier = (c: CtContainer) => c.live?.carrier ?? c.live?.carrierScac ?? c.forwarder ?? null;

/** Delivered date for the page's status logic: the ACT gate-out movement, else CDS. */
export function deliveredOf(c: CtContainer): string | null {
  const m = [...(c.live?.movements ?? [])].reverse().find((x) => x.status === 'ACT' && (x.event === 'GTOT' || x.event === 'EMRT'));
  if (m) return m.timestamp.slice(0, 10);
  if (c.century?.status && (c.century.status === 'GATE_OUT' || c.century.status === 'EMPTY_RETURN')) return c.century.eventAt ?? c.deliveredDate ?? null;
  if (c.chr?.deliveredAt) return c.chr.deliveredAt;
  if (c.chr?.status && (c.chr.status === 'GATE_OUT' || c.chr.status === 'EMPTY_RETURN')) return c.chr.ata ?? c.deliveredDate ?? null;
  return c.deliveredDate ?? null;
}

/** Index containers by PO line and by PO (for ShipsGo-only boxes whose items we don't know). */
/** "600509068, 070, 071, 072" → ["600509068","600509070","600509071","600509072"] — the shorthand Dimi uses in
 *  ShipsGo references and the schedule; a short token replaces the tail of the last full number. */
export function expandNumberList(text: string | null | undefined): string[] {
  const out: string[] = [];
  let base = '';
  for (const tok of String(text ?? '').match(/\d+/g) ?? []) {
    if (tok.length >= 7) { base = tok; out.push(tok); }
    else if (base && tok.length < base.length) out.push(base.slice(0, base.length - tok.length) + tok);
  }
  return [...new Set(out)];
}

/** Hayward US sales-order numbers (6005xxxxx) named in a box's ShipsGo / CHR reference — the AS400 "US SO#" column. */
export function usSoNumbersOf(c: CtContainer): string[] {
  return expandNumberList(`${c.live?.reference ?? ''} ${c.chr?.reference ?? ''}`).filter((n) => /^6\d{8}$/.test(n));
}

export function indexContainers(cs: CtContainer[]) {
  const byLine = new Map<string, CtContainer[]>();
  const byPo = new Map<string, CtContainer[]>();
  const bySo = new Map<string, CtContainer[]>();
  for (const c of cs) {
    for (const so of usSoNumbersOf(c)) (bySo.get(so) ?? bySo.set(so, []).get(so)!).push(c);
    const seenLine = new Set<string>();
    for (const l of c.lines) {
      const k = lineKey(l.po, l.item ?? (l as any).supplierItem);
      if (seenLine.has(k)) continue;
      seenLine.add(k);
      (byLine.get(k) ?? byLine.set(k, []).get(k)!).push(c);
    }
    for (const po of c.pos) (byPo.get(po) ?? byPo.set(po, []).get(po)!).push(c);
  }
  return { byLine, byPo, bySo };
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
      {!c.live?.eta && !c.century?.currentEta && c.chr?.eta && <span className="ml-1 text-slate-400">(CHR)</span>}
      {!c.live?.eta && !c.century?.currentEta && c.eta && <span className="ml-1 text-slate-400">(CDS)</span>}
      {c.live?.etaPredicted && c.live.etaPredicted !== eta && <span className="ml-1 text-slate-500" title="ShipsGo's ETA-prediction model (carrier ETAs often lag reality)">· predicted {fmtD(c.live.etaPredicted)}</span>}
    </span>
  );
}

export function ContainerCard({ c, po, item, poOnly, probable, matched }: { c: CtContainer; po: string; item: string; poOnly?: boolean; probable?: string; matched?: string }) {
  const qty = qtyInContainer(c, po, item);
  const shown = c.live?.movements ?? []; // every milestone, always — no manual expand
  const otherPos = c.pos.filter((p) => p !== po);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-bold text-slate-900">{c.containerNo}</span>
        {c.size && <span className="text-slate-400">{c.size}</span>}
        <StatusChip c={c} />
        {qty != null
          ? <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">× {qty} of this line</span>
          : matched ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-800" title={matched}>{matched}</span>
          : probable ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800" title={probable}>Probable match — {probable}</span>
          : poOnly && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800" title="The booking names this PO but no document has confirmed which items are inside">PO-level — items not confirmed</span>}
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

      {!shown.length && !c.century?.event && c.chr && (
        <div className="mt-2 border-t border-slate-100 pt-2 text-slate-700">
          <span className="text-emerald-600">●</span> <b>{c.chr.statusRaw}</b>
          {c.chr.pickedUpAt && <span className="text-slate-500"> · picked up {fmtD(c.chr.pickedUpAt)}</span>}
          {c.chr.atd && <span className="text-slate-500"> · departed {fmtD(c.chr.atd)}</span>}
          {c.chr.ata && <span className="text-slate-500"> · arrived {fmtD(c.chr.ata)}</span>}
          {c.chr.deliverEta && !c.chr.deliveredAt && <span className="text-slate-500"> · delivery ETA {fmtD(c.chr.deliverEta)}</span>}
          <span className="text-slate-400"> (C.H. Robinson {c.chr.shipmentNo}{c.chr.reference ? ` · ref "${c.chr.reference}"` : ''})</span>
        </div>
      )}
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
        </ol>
      )}

      {c.schedule && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs">
          <span className="text-slate-400">Dimi's schedule</span>
          {c.schedule.revisedDelivery
            ? <span>Warehouse delivery <b className="text-slate-900">{fmtD(c.schedule.revisedDelivery)}</b></span>
            : c.schedule.eta && <span>ETA as keyed {fmtD(c.schedule.eta)}</span>}
          {c.schedule.location && <span>{c.schedule.location}</span>}
          {c.schedule.note && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{c.schedule.note}</span>}
          {c.schedule.items && <span className="text-slate-500" title={c.schedule.items}>{c.schedule.items.length > 90 ? c.schedule.items.slice(0, 90) + '…' : c.schedule.items}</span>}
        </div>
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

/** The expandable panel rendered under a Purchasing row: PO · SKU → the container(s) it is in. */
export function TrackingPanel({ po, item, lineContainers, poContainers, probable = [], matched = [] }: {
  po: string; item: string; lineContainers: CtContainer[]; poContainers: CtContainer[];
  probable?: Array<{ c: CtContainer; why: string }>;
  /** boxes whose ShipsGo/CHR reference names this line's US sales order — confirmed by SO, item qty unknown */
  matched?: Array<{ c: CtContainer; why: string }>;
}) {
  const lineNos = new Set([...lineContainers, ...matched.map((m) => m.c)].map((c) => c.containerNo));
  const extra = poContainers.filter((c) => !lineNos.has(c.containerNo));
  if (!lineContainers.length && !extra.length && !probable.length && !matched.length) {
    return <div className="px-3 py-2 text-xs text-slate-500">PO {po} · <span className="font-mono">{item}</span> — no container document or ShipsGo shipment mentions this PO yet.</div>;
  }
  const inBoxes = lineContainers.reduce((n, c) => n + (qtyInContainer(c, po, item) ?? 0), 0);
  const head = <>PO <b>{po}</b> · <span className="font-mono font-semibold">{item}</span></>;
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="text-xs text-slate-700">
        {head}{' '}
        {lineContainers.length
          ? <>→ <b>{inBoxes}</b> in <span className="font-mono font-semibold">{lineContainers.map((c) => c.containerNo).join(', ')}</span></>
          : matched.length
            ? <>→ in <span className="font-mono font-semibold">{matched.map((m) => m.c.containerNo).join(', ')}</span> ({matched[0].why})</>
          : probable.length
            ? <>→ probably in <span className="font-mono font-semibold">{probable.map((p) => p.c.containerNo).join(', ')}</span> (matched by ship date — see note on the card)</>
            : <>→ <b>not in any container yet</b>. PO {po}'s {extra.length} box{extra.length === 1 ? '' : 'es'} ({extra.map((c) => c.containerNo).join(', ')}) carr{extra.length === 1 ? 'ies' : 'y'} other lines of the PO.</>}
      </div>
      {lineContainers.map((c) => <ContainerCard key={c.containerNo} c={c} po={po} item={item} />)}
      {matched.map(({ c, why }) => <ContainerCard key={`m-${c.containerNo}`} c={c} po={po} item={item} matched={why} />)}
      {probable.map(({ c, why }) => <ContainerCard key={`p-${c.containerNo}`} c={c} po={po} item={item} probable={why} />)}
    </div>
  );
}
