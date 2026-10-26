'use client';

// app/dashboard/reconciliation/page.tsx
// Hidden scrollbar styles - removes scrollbars from both top and bottom
// while keeping scroll functionality intact
const SCROLLBAR_STYLE = `
  #top-scroll::-webkit-scrollbar,
  #bottom-scroll::-webkit-scrollbar { display: none; }
  #top-scroll { -ms-overflow-style: none; scrollbar-width: none; }
  #bottom-scroll { -ms-overflow-style: none; scrollbar-width: none; }
  #recon-table th, #recon-table td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

// Fixed column widths (px) — 23 columns. Sticky left offsets are derived from these,
// so change a width here and the frozen columns stay aligned.
const COL_ORDER  = [66, 84, 92, 100, 54];                 // Order: PO, Customer PO, Status, Type, Arrow PO status
const COL_ARROW  = [120, 112, 76, 76, 60, 64, 56];        // Arrow AU: Stock, Supplier SKU, Order date, ETA, Ordered, Received, SOH
const COL_SUPPLY = [100, 56, 56, 76, 76, 104];            // Supplier: PO ref, ENT, SHPD, Ship date, ETA, US SO#
const COL_SUPPLY_COLLAPSED = [34];                        // Supplier group collapsed to one narrow toggle column
const COL_SHIP   = [56, 230, 140, 76, 120];               // Shipment: On water, Container, Vessel, Cont. ETA, Supplier (minimums)
// Whatever width is left after the fixed columns is shared between these Shipment columns (weights) so the
// table always reaches the right edge of the card — the sticky Order/Arrow columns keep fixed widths because
// their frozen offsets are hard-coded.
const FLEX_SHIP  = [0, 3, 2, 0, 2];
const colWidths = (supplierOpen: boolean) => [...COL_ORDER, ...COL_ARROW, ...(supplierOpen ? COL_SUPPLY : COL_SUPPLY_COLLAPSED), ...COL_SHIP];
const COL_W = colWidths(true);
const TABLE_W = COL_W.reduce((a, b) => a + b, 0);
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 1.3;  // fit-to-screen may also scale UP (bigger text) when the screen is wider than the table
// Full-width PO reconciliation: Arrow AU vs AS400 (Snowflake upload) vs CDS-Net shipments.
// AS400 data is uploaded in the browser; shipment/container data comes from the container store
// (Century CSV, ShipsGo, supplier PDFs — and the CDS xlsx if one ever arrives via the mailbox).
// Container tracking (ShipsGo live status + US invoices + Wuxi packing slips, from /api/containers/view)
// folds into the "Shipment On Water" columns and opens as a panel under the row — see components/ContainerTracking.tsx.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  TrackingPanel, StatusChip, indexContainers, lineKey as ctLineKey, bestEta, bestVessel, bestCarrier, deliveredOf, ctStatus,
  type CtContainer,
} from '@/components/ContainerTracking';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArrowLine = {
  po: string;
  deliveryNote4: string;
  poStatus?: string;                     // PORMAST.STATUS_FLAG — 'O' open, 'Q' quote, '' as keyed (C/X never reach the page)
  arrowStock: string;
  supplierSku: string;
  description: string | null;
  stockCategory: string;
  creditor: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  qtyOutstanding: number;
  orderDate: string | null;
  requestedDate: string | null;
  onHand?: number;          // Arrow stock on hand, all locations (from stock:all via /api/recon/arrow)
  allocated?: number;
  backordered?: number;
};

type As400Line = {
  po: string;
  item: string;
  as400Ord: number;
  as400Shpd: number;
  as400OrderDate: string | null;
  eta: string | null;
  shipDate: string | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToCountry: string | null;
  shipToPostcode: string | null;
  usSoNumber: string | null;
};

type ShipLine = {
  po: string;
  item: string;
  container: string | null;
  vessel: string | null;
  etd: string | null;
  eta: string | null;
  delivered: string | null;
  units: number | null;
  carrier: string | null;
  origin: string | null;
  destPort: string | null;
  live?: boolean;            // came from the container store (ShipsGo/PDF), not the CDS line index
};

type ReconRow = ArrowLine & {
  as400Ord: number;
  as400Shpd: number;
  as400OrderDate: string | null;
  as400Eta: string | null;
  shipDate: string | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostcode: string | null;
  usSoNumber: string | null;
  onWater: number;
  container: string | null;
  vessel: string | null;
  containerEta: string | null;
  carrier: string | null;
  status: 'received' | 'missing' | 'not_received' | 'shipped' | 'in_transit' | 'delivered' | 'ok';
  lateVsRequest: boolean;
  qtyMismatch: boolean;
  matchType: 'exact' | 'alias' | null;   // alias = matched on PO + qty because SKU codes differ
  as400Item: string | null;              // the supplier's own item code from AS400
  shipped: boolean;                      // supplier has shipped (SHPD > 0) or a container carries the line
  shipDateOverdue: boolean;              // AS400 ship date has passed but nothing shipped yet
  bestEta: string | null;                // container ETA, else AS400 ETA
  daysOpen: number;                      // days since the Arrow order date
  stale: 'po-missing' | 'item-missing' | 'never-shipped' | null;  // see STALE_DAYS
};

// A line is STALE when it was ordered STALE_DAYS+ ago, nothing has shipped or been received, no container carries
// it, and AS400 gives no future ETA. Three flavours: the PO isn't in AS400 at all, the PO is but this item isn't
// (dropped/substituted at the supplier), or it was entered and never shipped. All three want a decision from
// purchasing — cancel the Arrow line or get the supplier to commit — rather than more waiting.
const STALE_DAYS = 120;

type As400Meta  = { uploadedAt: string | null; rows: number; filename: string | null };
type ShipMeta   = { receivedAt: string | null; rows: number; filename: string | null };
type ArrowMeta  = { generatedAt: string | null; rows: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmt = (d: string | null) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
};

const creditorName: Record<string, string> = {
  '17100': 'Hayward USA',
  '17115': 'Hayward USA',
  '17125': 'Hayward USA',
  '17200': 'Hayward Wuxi',
  '17350': 'Hayward Wuxi',
};

const HAYWARD_CREDITORS = new Set([
  '17100', '17115', '17125', '17200', '17300', '17350',
]);

function supplierTypeBadge(creditor: string | null, stockCategory?: string) {
  if (stockCategory === 'PR') {
    return <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold bg-purple-500 text-white whitespace-nowrap">Paramount</span>;
  }
  if (!creditor) return <span className="text-slate-400 text-[11px]">—</span>;
  if (HAYWARD_CREDITORS.has(creditor)) {
    return <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold bg-wave text-white whitespace-nowrap">Hayward</span>;
  }
  return <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold bg-slate-500 text-white whitespace-nowrap">3rd Party</span>;
}

const AUNZ_PORTS = new Set([
  'melbourne','sydney','brisbane','darwin','adelaide','perth','fremantle',
  'port botany','townsville','fisherman islands',
  'auckland','tauranga','lyttelton','wellington','napier','port chalmers',
  'nelson','christchurch','otago',
]);

function statusBadge(s: ReconRow['status']) {
  const map: Record<ReconRow['status'], { label: string; cls: string }> = {
    received:     { label: 'Received',    cls: 'bg-emerald-600 text-white' },
    missing:      { label: 'Missing',     cls: 'bg-red-500 text-white' },
    not_received: { label: 'Awaiting',    cls: 'bg-orange-400 text-white' },
    shipped:      { label: 'Shipped',     cls: 'bg-sky-500 text-white' },
    in_transit:   { label: 'In transit',  cls: 'bg-blue-500 text-white' },
    delivered:    { label: 'Delivered',   cls: 'bg-green-500 text-white' },
    ok:           { label: 'OK',          cls: 'bg-slate-400 text-white' },
  };
  const { label, cls } = map[s];
  return <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

const PO_STATUS_LABEL: Record<string, string> = { O: 'Open PO', Q: 'Quote', '': 'No status flag keyed', I: 'Status I', R: 'Status R' };

const STALE_WHY: Record<NonNullable<ReconRow['stale']>, string> = {
  'po-missing': 'The PO is not in AS400 at all — cancel the Arrow line or have the supplier enter it.',
  'item-missing': 'The PO is in AS400 but this item is not — dropped or substituted at the supplier; cancel the Arrow line unless they confirm it.',
  'never-shipped': 'Entered in AS400 but never shipped and the AS400 ETA has passed — chase for a ship date or cancel.',
};

function isException(x: ReconRow) {
  return x.status !== 'received' && (x.status === 'missing' || x.qtyMismatch || x.matchType === 'alias');
}

function addrMatch(row: ReconRow): 'ok' | 'warn' | 'unknown' {
  if (!row.shipToCity) return 'unknown';
  const city = row.shipToCity.toLowerCase();
  const au = ['dandenong', 'victoria', 'melbourne', 'sydney', 'brisbane', 'perth', 'adelaide'];
  return au.some((c) => city.includes(c)) ? 'ok' : 'warn';
}

// ---------------------------------------------------------------------------
// Parse AS400 CSV — handles quoted fields containing commas correctly.
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cols.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function parseAs400Csv(text: string): As400Line[] {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  if (lines.length < 2) return [];
  const hdr = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/"/g, ''));
  const idx = (n: string) => hdr.indexOf(n);
  const c = {
    po: idx('po'), item: idx('item'),
    ord: idx('as400_ord'), shpd: idx('as400_shpd'),
    as400OrderDate: idx('as400_order_date'),
    eta: idx('eta'), shipDate: idx('ship_date'),
    name: idx('ship_to_name'), city: idx('ship_to_city'),
    state: idx('ship_to_state'), country: idx('ship_to_country'),
    postcode: idx('ship_to_postcode'), so: idx('us_so_number'),
  };
  return lines.slice(1).flatMap((line) => {
    if (!line.trim()) return [];
    const cols = parseCsvLine(line);
    const po = cols[c.po];
    if (!po || !/^\d{6}$/.test(po)) return [];
    return [{
      po,
      item: cols[c.item] ?? '',
      as400Ord: Number(cols[c.ord]) || 0,
      as400Shpd: Number(cols[c.shpd]) || 0,
      as400OrderDate: cols[c.as400OrderDate] || null,
      eta: cols[c.eta] || null,
      shipDate: cols[c.shipDate] || null,
      shipToName: cols[c.name] || null,
      shipToCity: cols[c.city] || null,
      shipToState: cols[c.state] || null,
      shipToCountry: cols[c.country] || null,
      shipToPostcode: cols[c.postcode] || null,
      usSoNumber: cols[c.so] || null,
    }];
  });
}

// SheetJS loaded from CDN via a dynamic script tag (used by the AS400 .xlsx upload).
function loadSheetJS(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).XLSX) { resolve((window as any).XLSX); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve((window as any).XLSX);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// AS400 export may also arrive as .xlsx — convert the sheet holding the
// AS400_ORD header to CSV text and reuse the CSV parser.
async function readAs400File(file: File): Promise<As400Line[]> {
  if (!/\.xlsx?$/i.test(file.name)) return parseAs400Csv(await file.text());
  const XLSX = await loadSheetJS();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  for (const name of wb.SheetNames) {
    const csv: string = XLSX.utils.sheet_to_csv(wb.Sheets[name], { dateNF: 'yyyy-mm-dd', blankrows: false });
    const first = csv.split('\n')[0]?.toUpperCase() ?? '';
    if (first.includes('AS400_ORD')) return parseAs400Csv(csv);
  }
  return [];
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reconcile Arrow + AS400 + Shipment
// ---------------------------------------------------------------------------

// Matching key: uppercase, strip everything that isn't A-Z / 0-9. Removes
// trailing spaces, hidden characters from Arrow, and hyphen differences.
const normKey = (v: string | null | undefined) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

type As400Agg = {
  item: string; ord: number; shpd: number;
  eta: string | null; shipDate: string | null; orderDate: string | null;
  usSo: string | null; shipToName: string | null; shipToCity: string | null;
  shipToState: string | null; shipToPostcode: string | null;
};

function reconcile(arrow: ArrowLine[], as400: As400Line[], ship: ShipLine[]): ReconRow[] {
  const today = new Date().toISOString().slice(0, 10);
  const maxDate = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

  // ── AS400: Wuxi lines appear twice (US intercompany SO + Wuxi SO) with the
  //    same qty. Sum within each SO (keeps genuine split lines), then take the
  //    MAX across SOs so the duplicate never doubles the quantity.
  const perSo = new Map<string, Map<string, As400Agg>>(); // po|key -> so -> agg
  for (const r of as400) {
    const k = `${r.po}|${normKey(r.item)}`;
    const so = String(r.usSoNumber ?? '').trim();
    if (!perSo.has(k)) perSo.set(k, new Map());
    const bySo = perSo.get(k)!;
    const ex = bySo.get(so);
    if (!ex) {
      bySo.set(so, {
        item: r.item, ord: r.as400Ord, shpd: r.as400Shpd, eta: r.eta, shipDate: r.shipDate,
        orderDate: r.as400OrderDate, usSo: so || null, shipToName: r.shipToName,
        shipToCity: r.shipToCity, shipToState: r.shipToState, shipToPostcode: r.shipToPostcode,
      });
    } else {
      ex.ord += r.as400Ord; ex.shpd += r.as400Shpd;
      ex.eta = maxDate(ex.eta, r.eta); ex.shipDate = maxDate(ex.shipDate, r.shipDate);
    }
  }
  const a4Map = new Map<string, As400Agg>();
  const a4ByPo = new Map<string, string[]>(); // po -> keys
  const as400Pos = new Set(as400.map((l) => l.po)); // POs AS400 knows at all (for the stale flavour)
  perSo.forEach((bySo, k) => {
    const list = Array.from(bySo.values());
    const best = list.reduce((x, y) => (y.ord > x.ord ? y : x));
    a4Map.set(k, {
      ...best,
      shpd: Math.max(...list.map((x) => x.shpd)),
      eta: list.reduce<string | null>((m, x) => maxDate(m, x.eta), null),
      shipDate: list.reduce<string | null>((m, x) => maxDate(m, x.shipDate), null),
      usSo: list.map((x) => x.usSo).filter(Boolean).join(', ') || null,
    });
    const po = k.split('|')[0];
    if (!a4ByPo.has(po)) a4ByPo.set(po, []);
    a4ByPo.get(po)!.push(k);
  });

  // ── Shipments (AU/NZ only, already filtered on upload)
  const shipMap = new Map<string, ShipLine[]>();
  for (const sl of ship) {
    const k = `${sl.po}|${normKey(sl.item)}`;
    if (!shipMap.has(k)) shipMap.set(k, []);
    shipMap.get(k)!.push(sl);
  }

  // ── Pass 1: exact (normalised) SKU match
  const matched = new Map<number, { key: string; type: 'exact' | 'alias' }>();
  const usedA4 = new Set<string>();
  arrow.forEach((a, i) => {
    const k = `${a.po}|${normKey(a.supplierSku)}`;
    if (normKey(a.supplierSku) && a4Map.has(k)) { matched.set(i, { key: k, type: 'exact' }); usedA4.add(k); }
  });

  // ── Pass 2: SKU codes differ between Arrow and AS400 (e.g. C150SWAU vs C150S,
  //    or Arrow sundry code 00.06.3260.00). Match on same PO + same qty, only
  //    when exactly one unmatched line on each side has that qty.
  const unmatchedByPo = new Map<string, number[]>();
  arrow.forEach((a, i) => {
    if (matched.has(i)) return;
    if (!unmatchedByPo.has(a.po)) unmatchedByPo.set(a.po, []);
    unmatchedByPo.get(a.po)!.push(i);
  });
  unmatchedByPo.forEach((idxs, po) => {
    const free = (a4ByPo.get(po) ?? []).filter((k) => !usedA4.has(k));
    for (const i of idxs) {
      const q = Math.round(arrow[i].qtyOrdered);
      const sameQtyArrow = idxs.filter((j) => Math.round(arrow[j].qtyOrdered) === q && !matched.has(j));
      const cands = free.filter((k) => !usedA4.has(k) && Math.round(a4Map.get(k)!.ord) === q);
      if (cands.length === 1 && sameQtyArrow.length === 1) {
        matched.set(i, { key: cands[0], type: 'alias' });
        usedA4.add(cands[0]);
      }
    }
  });

  return arrow.map((a, i): ReconRow => {
    const m = matched.get(i) ?? null;
    const a4 = m ? a4Map.get(m.key)! : null;
    // container lookup: try the supplier's item code first, then Arrow's
    const ships = [
      ...(a4 ? shipMap.get(`${a.po}|${normKey(a4.item)}`) ?? [] : []),
      ...(!a4 || normKey(a4.item) !== normKey(a.supplierSku) ? shipMap.get(`${a.po}|${normKey(a.supplierSku)}`) ?? [] : []),
    ].sort((x, y) => (y.eta ?? '').localeCompare(x.eta ?? ''));
    const latest = ships[0] ?? null;

    const as400Ord  = a4?.ord  ?? 0;
    const as400Shpd = a4?.shpd ?? 0;
    // Units confirmed in containers for this line (invoice / packing slip / Century / CDS), across all its boxes.
    // When we have that, it beats AS400's SHPD — the invoice lands days before AS400 flips the line to shipped.
    const ctUnits = ships.reduce((sum, x) => sum + (x.units ?? 0), 0);
    // Shipped = the supplier says units left (SHPD > 0) or a container document carries the line.
    // AS400's SHIP_DATE is a schedule, not a fact — a passed date alone does NOT make a line shipped.
    const shipped = ctUnits > 0 || (!!a4 && as400Shpd > 0);
    const shipDateOverdue = !shipped && !!a4?.shipDate && a4.shipDate < today && a.qtyOutstanding > 0;
    const daysOpen = a.orderDate ? Math.round((Date.parse(today) - Date.parse(a.orderDate)) / 86400000) : 0;
    const stale: ReconRow['stale'] = !shipped && a.qtyReceived <= 0 && a.qtyOutstanding > 0 && daysOpen >= STALE_DAYS && !(a4?.eta && a4.eta > today)
      ? (!a4 ? (as400Pos.has(a.po) ? 'item-missing' : 'po-missing') : 'never-shipped')
      : null;
    const onWater = !shipped ? 0
      : ctUnits > 0 ? Math.max(0, Math.max(ctUnits, as400Shpd) - a.qtyReceived)
      : as400Shpd > 0 ? Math.max(0, as400Shpd - a.qtyReceived)
      : a.qtyOutstanding;

    let status: ReconRow['status'] = 'ok';
    // Fully received in Arrow — the line is done whatever AS400 or the forwarders say; kept on the page so the whole PO is visible.
    if (a.qtyOutstanding <= 0 && a.qtyReceived > 0) status = 'received';
    else if (!a4)                  status = 'missing';
    else if (latest?.delivered)    status = 'delivered';
    else if (latest)               status = 'in_transit';
    else if (shipped)              status = 'shipped';
    else if (a.qtyOutstanding > 0) status = 'not_received';

    const qtyMismatch = !!a4 && Math.round(as400Ord) !== Math.round(a.qtyOrdered);
    const bestEta = latest?.eta ?? a4?.eta ?? null;
    // Arrow's requested date is keyed by purchasing when the PO is raised and is not a forecast —
    // it is shown for reference only and never drives status, exceptions or highlighting.
    const lateVsRequest = false;

    return {
      ...a,
      as400Ord, as400Shpd,
      as400OrderDate: a4?.orderDate ?? null,
      as400Eta:       a4?.eta ?? null,
      shipDate:       a4?.shipDate ?? null,
      shipToName:     a4?.shipToName ?? null,
      shipToCity:     a4?.shipToCity ?? null,
      shipToState:    a4?.shipToState ?? null,
      shipToPostcode: a4?.shipToPostcode ?? null,
      usSoNumber:     a4?.usSo ?? null,
      onWater,
      container:    ships.length ? Array.from(new Set(ships.map((x) => x.container).filter(Boolean))).join(', ') || null : null,
      vessel:       latest?.vessel ?? null,
      containerEta: latest?.eta ?? null,
      carrier:      latest?.carrier ?? null,
      status,
      lateVsRequest,
      qtyMismatch,
      matchType: m?.type ?? null,
      as400Item: a4?.item ?? null,
      shipped,
      shipDateOverdue,
      bestEta,
      daysOpen,
      stale,
    };
  });
}

// ---------------------------------------------------------------------------
// Upload banner component (reused for both AS400 and Shipment)
// ---------------------------------------------------------------------------

function UploadBanner({
  label, sublabel, hint, meta, uploading, accept, onFile, multiple, onFiles, note, collapseHint,
}: {
  label: string;
  sublabel: string;
  hint: string;
  meta: string;
  uploading: boolean;
  accept: string;
  onFile?: (f: File) => void;
  multiple?: boolean;
  onFiles?: (f: File[]) => void;
  note?: string | null;
  collapseHint?: boolean;   // tuck the long instructions behind a ▸ toggle
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">{label} {meta && <span className="font-normal text-slate-400">· {meta}</span>}</span>
        <span className="shrink-0 text-xs text-slate-400">{sublabel}</span>
      </div>
      {collapseHint ? (
        <details className="mb-3 text-xs text-slate-500">
          <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-600">What can I drop here?</summary>
          <p className="mt-1">{hint}</p>
        </details>
      ) : (
        <p className="mb-3 text-xs text-slate-500">{hint}</p>
      )}
      <input
        ref={ref} type="file" accept={accept} className="hidden" multiple={!!multiple}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          if (multiple && onFiles) { if (list.length) onFiles(list); }
          else if (list[0] && onFile) onFile(list[0]);
          e.target.value = '';
        }}
      />
      <button
        onClick={() => ref.current?.click()}
        disabled={uploading}
        className="inline-flex items-center gap-2 rounded-lg bg-wave px-4 py-2 text-sm font-medium text-white hover:bg-deep disabled:opacity-60"
      >
        {uploading ? 'Processing…' : multiple ? '↑ Choose files' : '↑ Choose file'}
      </button>
      {note && <p className="mt-2 whitespace-pre-wrap text-xs text-slate-600">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'exceptions' | 'stale' | 'not_received' | 'shipped' | 'in_transit' | 'delivered' | 'received';

export default function ReconciliationPage() {
  const [arrowLines, setArrowLines] = useState<ArrowLine[]>([]);
  const [as400Lines, setAs400Lines] = useState<As400Line[]>([]);
  const [shipLines,  setShipLines]  = useState<ShipLine[]>([]);
  const [as400Meta,  setAs400Meta]  = useState<As400Meta>({ uploadedAt: null, rows: 0, filename: null });
  const [shipMeta,   setShipMeta]   = useState<ShipMeta>({ receivedAt: null, rows: 0, filename: null });
  const [arrowMeta,  setArrowMeta]  = useState<ArrowMeta>({ generatedAt: null, rows: 0 });
  const [loading,    setLoading]    = useState(true);
  const [tab,        setTab]        = useState<FilterTab>('all');
  const [search,     setSearch]     = useState('');
  const [uploadingA4, setUploadingA4] = useState(false);
  // Container tracking store (ShipsGo live + supplier PDFs + CDS container facts)
  const [ctContainers, setCtContainers] = useState<CtContainer[]>([]);
  const [ctInfo, setCtInfo] = useState<{ meta: any; refresh: any; shipsgoConfigured: boolean; total: number }>({ meta: null, refresh: null, shipsgoConfigured: false, total: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshingCt, setRefreshingCt] = useState(false);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [docsNote, setDocsNote] = useState<string | null>(null);
  // Stock scope: 'all' (default) shows every Arrow line; the other two narrow it.
  const [scope,            setScope]            = useState<'all' | 'hayward' | 'paramount'>('all');

  // Fit-to-screen: scale the table so all 23 columns are visible at 100% browser zoom.
  const [fitToScreen, setFitToScreen] = useState(true);
  // Supplier USA-China column group: collapsed by default (like hiding a column group in Excel); remembered per browser.
  const [supplierOpen, setSupplierOpen] = useState(false);
  useEffect(() => { try { setSupplierOpen(localStorage.getItem('recon.supplierOpen') === '1'); } catch { /* ignore */ } }, []);
  const toggleSupplier = useCallback(() => setSupplierOpen((v) => { try { localStorage.setItem('recon.supplierOpen', v ? '0' : '1'); } catch { /* ignore */ } return !v; }), []);
  const baseCols = colWidths(supplierOpen);
  const baseW = baseCols.reduce((a, b) => a + b, 0);
  const colCount = baseCols.length;
  const [availWidth,  setAvailWidth]  = useState<number>(TABLE_W);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    const measure = () => setAvailWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]); // wrapper only exists once data has loaded
  // Fit: scale so the fixed columns fit (down to MIN_ZOOM) or, on a wide screen, scale up to MAX_ZOOM; then give any
  // width still left over to the flexible Shipment columns so the table ends at the card's right edge either way.
  const tableZoom = fitToScreen ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (availWidth - 2) / baseW)) : 1;
  const slack = Math.max(0, (availWidth - 2) / tableZoom - baseW);
  const flexSum = FLEX_SHIP.reduce((a, b) => a + b, 0);
  const cols = baseCols.map((w, i) => {
    const fi = i - (colCount - COL_SHIP.length);
    return fi >= 0 && FLEX_SHIP[fi] ? Math.floor(w + (slack * FLEX_SHIP[fi]) / flexSum) : w;
  });
  const tableW = cols.reduce((a, b) => a + b, 0);
  // Frozen-column offsets (cumulative widths of the Order + Arrow columns).
  const left = cols.reduce<number[]>((acc, w, i) => { acc.push(i === 0 ? 0 : acc[i - 1] + cols[i - 1]); return acc; }, []);
  // Frozen header: the two header rows stick under the filter bar while the page scrolls. Only possible in
  // fit mode, where the card needs no horizontal scrollbar (a scroll container would trap the sticky header).
  const filterRef = useRef<HTMLDivElement>(null);
  const [filterH, setFilterH] = useState(60);
  useEffect(() => {
    const el = filterRef.current;
    if (!el) return;
    const m = () => setFilterH(el.offsetHeight);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const headTop = fitToScreen ? filterH / tableZoom : undefined;

  useEffect(() => {
    Promise.all([
      fetch('/api/recon/arrow').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recon/shipment').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recon/as400').then((r) => r.json()).catch(() => ({})),
      fetch('/api/containers/view').then((r) => r.json()).catch(() => ({})),
    ]).then(([arrow, ship, a400, ct]) => {
      setArrowLines(arrow.lines ?? []);
      setArrowMeta({ generatedAt: arrow.generatedAt ?? null, rows: arrow.lines?.length ?? 0 });
      setShipLines(ship.lines ?? []);
      setShipMeta({ receivedAt: ship.receivedAt ?? null, rows: ship.lines?.length ?? 0, filename: ship.filename ?? ship.subject ?? null });
      setAs400Lines(a400.lines ?? []);
      setAs400Meta({ uploadedAt: a400.uploadedAt ?? null, rows: a400.lines?.length ?? 0, filename: a400.filename ?? null });
      setCtContainers(Array.isArray(ct?.containers) ? ct.containers : []);
      setCtInfo({ meta: ct?.meta ?? null, refresh: ct?.refresh ?? null, shipsgoConfigured: !!ct?.shipsgoConfigured, total: ct?.total ?? 0 });
    }).finally(() => setLoading(false));
  }, []);

  const reloadContainers = useCallback(async () => {
    const ct = await fetch('/api/containers/view').then((r) => r.json()).catch(() => ({}));
    setCtContainers(Array.isArray(ct?.containers) ? ct.containers : []);
    setCtInfo({ meta: ct?.meta ?? null, refresh: ct?.refresh ?? null, shipsgoConfigured: !!ct?.shipsgoConfigured, total: ct?.total ?? 0 });
    const ship = await fetch('/api/recon/shipment').then((r) => r.json()).catch(() => ({}));
    if (Array.isArray(ship?.lines)) {
      setShipLines(ship.lines);
      setShipMeta({ receivedAt: ship.receivedAt ?? null, rows: ship.lines.length, filename: ship.filename ?? ship.subject ?? null });
    }
  }, []);

  // "Refresh tracking" — pull the ShipsGo account now (the cron does this 2-hourly)
  const handleRefreshTracking = useCallback(async () => {
    setRefreshingCt(true);
    try {
      const res = await fetch('/api/containers/refresh', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      await reloadContainers();
      setDocsNote(`ShipsGo: ${j.shipments} shipments on the account · ${j.containersTouched} containers updated · ${j.changed?.length ?? 0} ETA/status changes${j.credits?.remaining != null ? ` · ${j.credits.remaining} credits left` : ''}${j.errors?.length ? ` · ${j.errors.length} errors` : ''}`);
    } catch (e: any) {
      alert('Refresh failed: ' + e.message);
    } finally {
      setRefreshingCt(false);
    }
  }, [reloadContainers]);

  // Container documents (US invoice PDF, Wuxi packing slip PDF, CDS xlsx, or whole .msg emails)
  const handleDocFiles = useCallback(async (files: File[]) => {
    setUploadingDocs(true);
    try {
      // Vercel caps a request body at 4.5 MB, so send the files in batches (invoice PDFs are ~320 KB each).
      const MAX_BYTES = 3_500_000, MAX_FILES = 8;
      const batches: File[][] = [];
      let cur: File[] = [], size = 0;
      for (const f of files) {
        if (cur.length && (size + f.size > MAX_BYTES || cur.length >= MAX_FILES)) { batches.push(cur); cur = []; size = 0; }
        cur.push(f); size += f.size;
      }
      if (cur.length) batches.push(cur);
      const results: any[] = [];
      for (let i = 0; i < batches.length; i++) {
        setDocsNote(`Uploading batch ${i + 1} of ${batches.length} (${batches[i].length} file${batches[i].length === 1 ? '' : 's'})…`);
        const fd = new FormData();
        for (const f of batches[i]) fd.append('files', f);
        const res = await fetch('/api/containers/upload', { method: 'POST', body: fd });
        const text = await res.text();
        let j: any;
        try { j = JSON.parse(text); } catch { throw new Error(`${res.status} ${text.slice(0, 120)}`); }
        if (!res.ok) throw new Error(j.error ?? res.statusText);
        results.push(...(j.results as any[]));
      }
      const lines = results.map((r) => {
        if (r.error) return `✗ ${r.file}: ${r.error}`;
        if (r.skipped) return `– ${r.file}: ${r.skipped}`;
        const reg = r.registration?.results?.length ? ` · ShipsGo: ${r.registration.results.filter((x: any) => x.ok).length}/${r.registration.results.length} registered` : '';
        const w = r.warnings?.length ? ` · ⚠ ${r.warnings.join('; ')}` : '';
        return `✓ ${r.file}: ${r.parsed.lines} lines, ${r.parsed.containers} container(s)${r.newContainers?.length ? ` (new: ${r.newContainers.join(', ')})` : ''}${r.parsed.cdsLines != null ? ` · CDS index ${r.parsed.cdsLines} AU/NZ lines` : ''}${reg}${w}`;
      });
      setDocsNote(lines.join('\n'));
      await reloadContainers();
    } catch (e: any) {
      alert('Upload failed: ' + e.message);
    } finally {
      setUploadingDocs(false);
    }
  }, [reloadContainers]);

  // Auto-enable Paramount button if user only has access to Paramount POs
  // (i.e., they receive only PR stock category from API - like Poolwater Products)
  useEffect(() => {
    if (arrowLines.length === 0) return;
    const hasParamount = arrowLines.some((l) => l.stockCategory === 'PR');
    const hasNonParamount = arrowLines.some((l) => l.stockCategory !== 'PR');
    if (hasParamount && !hasNonParamount) {
      setScope('paramount');
    }
  }, [arrowLines]);

  // AS400 CSV upload
  const handleAs400File = useCallback(async (file: File) => {
    setUploadingA4(true);
    try {
      const lines = await readAs400File(file);
      if (!lines.length) { alert('No valid AU PO rows found. Check the column headers match the Snowflake query output.'); return; }
      const res = await fetch('/api/recon/as400-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines, filename: file.name, uploadedAt: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAs400Lines(lines);
      setAs400Meta({ uploadedAt: new Date().toISOString(), rows: lines.length, filename: file.name });
    } catch (e: any) {
      alert('AS400 upload failed: ' + e.message);
    } finally {
      setUploadingA4(false);
    }
  }, []);

  // Container store → ShipLine[] so the existing reconcile() picks up live ETA/vessel/status.
  // A CDS line for the same PO + item + container is superseded by the store version (which carries ShipsGo data).
  const ctIdx = useMemo(() => indexContainers(ctContainers), [ctContainers]);
  const shipAll = useMemo<ShipLine[]>(() => {
    const fromCt: ShipLine[] = [];
    const covered = new Set<string>();
    for (const c of ctContainers) {
      const seen = new Set<string>();
      for (const l of c.lines) {
        const k = `${ctLineKey(l.po, l.item)}|${c.containerNo}`;
        if (seen.has(k)) continue;
        seen.add(k); covered.add(k);
        fromCt.push({
          po: l.po, item: l.item, container: c.containerNo, vessel: bestVessel(c), etd: c.live?.etd ?? c.etd ?? null, eta: bestEta(c),
          delivered: deliveredOf(c), units: l.qty, carrier: bestCarrier(c), origin: c.live?.pol ?? c.originPort ?? null, destPort: c.live?.pod ?? c.destPort ?? null,
          live: true,
        });
      }
    }
    const cds = shipLines.filter((sl) => !sl.container || !covered.has(`${ctLineKey(sl.po, sl.item)}|${sl.container}`));
    return [...cds, ...fromCt];
  }, [shipLines, ctContainers]);

  const rows = useMemo(() => reconcile(arrowLines, as400Lines, shipAll), [arrowLines, as400Lines, shipAll]);

  // CHR bookings from the US reference a date, not a PO ("9/25", "week 34"). For US-supplier lines with no
  // confirmed box, suggest CHR containers whose pickup/departure is within a week of the AS400 ship date.
  const usUnassigned = useMemo(() => ctContainers.filter((c) => !c.pos.length && c.chr?.usOrigin), [ctContainers]);
  const probableFor = useCallback((r: ReconRow): Array<{ c: CtContainer; why: string }> => {
    // Only for lines with shipped-but-unreceived quantity: if everything shipped has already been received,
    // no box can be carrying this line's balance.
    if (!r.shipDate || r.onWater <= 0 || !usUnassigned.length || !/^171(00|15|25)$/.test(r.creditor ?? '')) return [];
    const ship = new Date(r.shipDate).getTime();
    return usUnassigned.flatMap((c) => {
      const d = c.chr?.pickedUpAt ?? c.chr?.atd ?? c.chr?.etd;
      if (!d) return [];
      const days = Math.round((new Date(d).getTime() - ship) / 86400000);
      if (Math.abs(days) > 7) return [];
      return [{ c, why: `CHR ref "${c.chr?.reference ?? '—'}" ${c.chr?.pickedUpAt ? 'picked up' : 'departed'} ${fmt(d)}, AS400 ship date ${fmt(r.shipDate)} — booking carries no PO` }];
    });
  }, [usUnassigned]);

  const toggleRow = useCallback((k: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);

  // Every container a row can be shown with — confirmed, PO-level, or probable — plus MBLs, for search.
  // Typing a container number (or part of one) filters to the PO lines that box carries.
  const containerText = useCallback((x: ReconRow): string => {
    const line = ctIdx.byLine.get(ctLineKey(x.po, x.supplierSku)) ?? (x.as400Item ? ctIdx.byLine.get(ctLineKey(x.po, x.as400Item)) : undefined) ?? [];
    // Only the boxes this row is actually SHOWN with: its own line-level containers; else the US-SO match; else
    // (line in no box yet) the PO-level boxes / probable match. A container search must not hit every line of a PO.
    const so = !line.length && x.usSoNumber ? ctIdx.bySo.get(x.usSoNumber.replace(/^0+/, '')) ?? [] : [];
    const po = !line.length && !so.length ? ctIdx.byPo.get(x.po) ?? [] : [];
    const prob = !line.length && !so.length && !po.length ? probableFor(x).map((p) => p.c) : [];
    return [...line, ...so, ...po, ...prob].map((c) => `${c.containerNo} ${c.mbl ?? ''} ${c.live?.reference ?? ''}`).join(' ').toLowerCase();
  }, [ctIdx, probableFor]);

  const filtered = useMemo(() => {
    let r = rows;
    if (scope === 'paramount') r = r.filter((x) => x.stockCategory === 'PR');
    if (scope === 'hayward')   r = r.filter((x) => x.stockCategory !== 'PR');
    if (tab === 'exceptions')   r = r.filter(isException);
    if (tab === 'stale')        r = r.filter((x) => !!x.stale);
    if (tab === 'not_received') r = r.filter((x) => x.status === 'not_received');
    if (tab === 'shipped')      r = r.filter((x) => x.status === 'shipped');
    if (tab === 'in_transit')   r = r.filter((x) => x.status === 'in_transit');
    if (tab === 'delivered')    r = r.filter((x) => x.status === 'delivered');
    if (tab === 'received')     r = r.filter((x) => x.status === 'received');
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter((x) =>
        x.po.includes(q) ||
        (x.deliveryNote4 ?? '').toLowerCase().includes(q) ||
        x.arrowStock.toLowerCase().includes(q) ||
        x.supplierSku.toLowerCase().includes(q) ||
        (x.description ?? '').toLowerCase().includes(q) ||
        (x.creditor ?? '').toLowerCase().includes(q) ||
        (creditorName[x.creditor ?? ''] ?? '').toLowerCase().includes(q) ||
        (x.usSoNumber ?? '').toLowerCase().includes(q) ||
        (x.as400Item ?? '').toLowerCase().includes(q) ||
        (x.container ?? '').toLowerCase().includes(q) ||
        (x.vessel ?? '').toLowerCase().includes(q) ||
        // A 6-digit PO search must not match other POs via a ShipsGo reference like "Hayward AU PO 918494, 918214"
        (!/^\d{6}$/.test(q) && containerText(x).includes(q.replace(/\s/g, ''))) ||
        (x.shipToName ?? '').toLowerCase().includes(q) ||
        (x.shipToCity ?? '').toLowerCase().includes(q),
      );
    }
    return r;
  }, [rows, tab, search, scope, containerText]);

  const stats = useMemo(() => {
    const inScope = rows.filter((x) =>
      scope === 'paramount' ? x.stockCategory === 'PR'
      : scope === 'hayward' ? x.stockCategory !== 'PR'
      : true);
    return {
      total:      inScope.length,
      exceptions: inScope.filter(isException).length,
      stale:      inScope.filter((x) => !!x.stale).length,
      missing:    inScope.filter((x) => x.status === 'missing').length,
      awaiting:   inScope.filter((x) => x.status === 'not_received').length,
      shipped:    inScope.filter((x) => x.status === 'shipped').length,
      inTransit:  inScope.filter((x) => x.status === 'in_transit').length,
      delivered:  inScope.filter((x) => x.status === 'delivered').length,
      received:   inScope.filter((x) => x.status === 'received').length,
      late:       inScope.filter((x) => x.lateVsRequest).length,
    };
  }, [rows, scope]);

  // Data freshness — warn when any source is out of date
  const staleWarnings = useMemo(() => {
    const ageH = (d: string | null) => (d ? (Date.now() - new Date(d).getTime()) / 3_600_000 : Infinity);
    const w: string[] = [];
    if (ageH(arrowMeta.generatedAt) > 24) w.push(`Arrow POs last synced ${arrowMeta.generatedAt ? new Date(arrowMeta.generatedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'never'} — check arrow-recon.js is scheduled on AZ-Grey`);
    if (ageH(as400Meta.uploadedAt) > 72) w.push(`AS400 data uploaded ${as400Meta.uploadedAt ? new Date(as400Meta.uploadedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'never'} — upload a fresh export below`);
    if (ageH(ctInfo.meta?.lastCenturyAt ?? null) > 30) w.push(`Century container CSV last loaded ${ctInfo.meta?.lastCenturyAt ? new Date(ctInfo.meta.lastCenturyAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'never'} — export today's "all containers shipped to AU/NZ" CSV from the Century dashboard and drop it below`);
    if (ctInfo.shipsgoConfigured && ageH(ctInfo.refresh?.at ?? null) > 8) w.push(`ShipsGo tracking last refreshed ${ctInfo.refresh?.at ? new Date(ctInfo.refresh.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'} — check the /api/containers/refresh cron, or press Refresh tracking`);
    return w;
  }, [arrowMeta, as400Meta, shipMeta, ctInfo]);

  const fmtMeta = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

  const tabs: { id: FilterTab; label: string; count?: number }[] = [
    { id: 'all',          label: 'All',           count: stats.total },
    { id: 'exceptions',   label: 'Exceptions',    count: stats.exceptions },
    { id: 'stale',        label: `Stale · ${STALE_DAYS}d+`, count: stats.stale },
    { id: 'not_received', label: 'Awaiting ship', count: stats.awaiting },
    { id: 'shipped',      label: 'Shipped · no container', count: stats.shipped },
    { id: 'in_transit',   label: 'In transit',    count: stats.inTransit },
    { id: 'delivered',    label: 'Delivered',      count: stats.delivered },
    { id: 'received',     label: 'Received',       count: stats.received },
  ];

  return (
    <div className="space-y-6">
      <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_STYLE }} />

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <span className="text-wave">⚓</span> Purchasing
          </h1>
        </div>
      </div>

      {/* ── Filter row — sticky below dashboard header ── */}
      <div ref={filterRef} className="sticky top-0 z-30 -mx-8 bg-white/95 backdrop-blur px-8 py-3 border-b border-slate-100 shadow-sm flex flex-wrap items-center gap-2">
        {/* Stock group toggles — LEFT */}
        <div className="flex gap-2 mr-4">
          {([
            { id: 'all',       label: 'All stock' },
            { id: 'hayward',   label: 'Hayward' },
            { id: 'paramount', label: 'Paramount' },
          ] as const).map((o) => (
            <button
              key={o.id}
              onClick={() => setScope(o.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
                scope === o.id
                  ? (o.id === 'paramount' ? 'bg-purple-600 text-white border-purple-600' : 'bg-ink text-white border-ink')
                  : 'bg-white text-slate-500 border-slate-200 hover:border-purple-400 hover:text-purple-600'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Search and tabs — CENTER */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search PO, SKU, container, MBL, vessel, supplier…"
          className="w-96 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-wave focus:ring-2 focus:ring-wave/20"
        />
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id
                  ? 'bg-wave text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:border-wave hover:text-wave'
              }`}
            >
              {t.label}{t.count !== undefined ? ` · ${t.count}` : ''}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="py-16 text-center text-sm text-slate-400">Loading…</div>
      ) : (
        <>
          {/* Export button — right-aligned above table */}
          <div className="flex justify-end items-center gap-2 mb-2">
            <button
              onClick={() => document.getElementById('uploads')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              title="Jump to the upload area at the bottom of the page"
              className="flex items-center gap-2 rounded-xl border border-ink/10 bg-white px-4 py-2 text-sm font-medium shadow-soft hover:border-wave/30 transition-colors"
            >
              ↓ Uploads
            </button>
            <button
              onClick={handleRefreshTracking}
              disabled={refreshingCt}
              title="Pull the latest status, ETA and milestones for every shipment on the ShipsGo account (the cron does this every 2 hours)"
              className="flex items-center gap-2 rounded-xl border border-ink/10 bg-white px-4 py-2 text-sm font-medium shadow-soft hover:border-wave/30 transition-colors disabled:opacity-60"
            >
              <span className={refreshingCt ? 'animate-spin' : ''}>⟳</span> {refreshingCt ? 'Refreshing…' : 'Refresh tracking'}
            </button>
            <button
              onClick={() => setFitToScreen((v) => !v)}
              title={fitToScreen ? 'Show the table at full size (scroll sideways)' : 'Shrink the table so every column fits'}
              className="flex items-center gap-2 rounded-xl border border-ink/10 bg-white px-4 py-2 text-sm font-medium shadow-soft hover:border-wave/30 transition-colors"
            >
              {fitToScreen ? '⤢ Actual size' : '⤡ Fit to screen'}
              {fitToScreen && Math.round(tableZoom * 100) !== 100 && <span className="text-xs text-slate-400">{Math.round(tableZoom * 100)}%</span>}
            </button>
            <button
              onClick={() => {
                const headers = [
                  'PO','Customer PO','Status','Type','Arrow PO status','Stock Code','Supplier SKU','Order Date','ETA Arrow',
                  'Ordered','Received','SOH','Allocated','Backordered','Arrow PO Ref','AS400 Item','Match','AS400 ENT','AS400 SHPD','Qty Mismatch','Ship Date','AS400 ETA','US SO#',
                  'On Water','Container','Vessel','Container ETA','Supplier','Tracking status','MBL','Invoice / Slip','Days open','Stale'
                ];
                const escape = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const csvRows = filtered.map(r => [
                  r.po, r.deliveryNote4 ?? '', r.status, HAYWARD_CREDITORS.has(r.creditor ?? '') ? 'Hayward' : '3rd Party', r.poStatus ?? '',
                  r.arrowStock, r.supplierSku, r.orderDate ?? '', r.requestedDate ?? '',
                  r.qtyOrdered, r.qtyReceived, r.onHand ?? '', r.allocated ?? '', r.backordered ?? '',
                  r.matchType ? r.po : '', r.as400Item ?? '', r.matchType ?? 'missing',
                  r.matchType ? r.as400Ord : 'missing', r.as400Shpd, r.qtyMismatch ? 'YES' : '',
                  r.shipDate ?? '', r.as400Eta ?? '', r.usSoNumber ?? '',
                  r.onWater, r.container ?? '', r.vessel ?? '', r.containerEta ?? '',
                  creditorName[r.creditor ?? ''] ?? r.creditor ?? '',
                  ...(() => {
                    const cs = ctIdx.byLine.get(ctLineKey(r.po, r.supplierSku)) ?? (r.as400Item ? ctIdx.byLine.get(ctLineKey(r.po, r.as400Item)) ?? [] : []);
                    return [
                      Array.from(new Set(cs.map((c) => ctStatus(c).label))).join(' / '),
                      Array.from(new Set(cs.map((c) => c.mbl).filter(Boolean))).join(' / '),
                      Array.from(new Set(cs.flatMap((c) => [...(c.invoiceNos ?? []).map((n) => `Inv ${n}`), ...(c.packingSlipNos ?? []).map((n) => `Slip ${n}`)]))).join(' / '),
                    ];
                  })(),
                  r.daysOpen, r.stale ? STALE_WHY[r.stale] : '',
                ].map(escape).join(','));
                const csv = [headers.map(escape).join(','), ...csvRows].join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `recon-${new Date().toISOString().slice(0,10)}.csv`;
                a.click(); URL.revokeObjectURL(url);
              }}
              className="flex items-center gap-2 rounded-xl border border-ink/10 bg-white px-4 py-2 text-sm font-medium shadow-soft hover:border-wave/30 transition-colors"
            >
              <svg className="h-4 w-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Export to Excel
            </button>
          </div>
          <div ref={tableWrapRef} className="rounded-2xl border border-ink/10 bg-white shadow-soft" style={{ overflow: 'clip' }}>
          {/* Top scrollbar mirror — synced to bottom scroll */}
          {!fitToScreen && <div
            id="top-scroll"
            className="overflow-x-auto"
            style={{ height: '18px' }}
            onScroll={(e) => {
              const bottom = document.getElementById('bottom-scroll');
              if (bottom) bottom.scrollLeft = (e.target as HTMLDivElement).scrollLeft;
            }}
          >
            <div id="top-scroll-inner" style={{ height: '1px' }} />
          </div>}
          {/* Table — full height (the page scrolls, not the table); horizontal scroll only */}
          <div
            id="bottom-scroll"
            style={{ overflowX: fitToScreen ? 'clip' : 'auto', overflowY: 'visible' }}
            onScroll={(e) => {
              const top = document.getElementById('top-scroll');
              if (top) top.scrollLeft = (e.target as HTMLDivElement).scrollLeft;
              const inner = document.getElementById('top-scroll-inner');
              const tbl = (e.target as HTMLDivElement).querySelector('table');
              if (inner && tbl) {
                const scrollbarWidth = (e.target as HTMLDivElement).offsetWidth - (e.target as HTMLDivElement).clientWidth;
                inner.style.width = (tbl.scrollWidth + scrollbarWidth) + 'px';
              }
            }}
            ref={(el) => {
              if (!el) return;
              const inner = document.getElementById('top-scroll-inner');
              const tbl = el.querySelector('table');
              if (inner && tbl) {
                // Account for scrollbar width: ensure top scroll can scroll as far as bottom
                const scrollbarWidth = el.offsetWidth - el.clientWidth;
                inner.style.width = (tbl.scrollWidth + scrollbarWidth) + 'px';
              }
            }}
          >
          <table id="recon-table" className="text-left text-xs" style={{ width: `${tableW}px`, tableLayout: 'fixed', borderCollapse: 'collapse', zoom: tableZoom }}>
            <colgroup>
              {cols.map((w, ci) => <col key={ci} style={{ width: `${w}px` }} />)}
            </colgroup>
            <thead className="sticky z-20" style={{ top: headTop ?? 0 }}>
              <tr className="text-[11px] font-bold uppercase tracking-widest">
                <th colSpan={5} style={{ background: '#334155', color: 'white', padding: '6px 8px', borderRight: '2px solid white', position: 'sticky', left: 0, zIndex: 11, opacity: 1 }}>
                  Order
                </th>
                <th colSpan={7} style={{ background: '#059669', color: 'white', padding: '6px 8px', borderRight: '2px solid white', opacity: 1 }}>
                  Arrow AU
                </th>
                <th colSpan={supplierOpen ? 6 : 1} onClick={toggleSupplier}
                    title={supplierOpen ? 'Collapse the Supplier USA-China columns' : 'Expand the Supplier USA-China columns (AS400 PO ref, ENT, SHPD, ship date, ETA, US SO#)'}
                    style={{ background: '#f59e0b', color: 'white', padding: '6px 8px', borderRight: '2px solid white', opacity: 1, cursor: 'pointer', userSelect: 'none', textAlign: supplierOpen ? 'left' : 'center' }}>
                  {supplierOpen ? '◂ Supplier USA-China' : '▸'}
                </th>
                <th colSpan={5} style={{ background: '#7c3aed', color: 'white', padding: '6px 8px', opacity: 1 }}>
                  Shipment On Water
                </th>
              </tr>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-normal">
                <th className="sticky left-0 z-10 bg-slate-800 px-2 py-2 whitespace-nowrap text-white opacity-100">PO</th>
                <th title="Customer PO (DELIVERY_NOTE_4)" className="sticky bg-slate-700 px-2 py-2 whitespace-nowrap text-white opacity-100" style={{ left: `${left[1]}px` }}>Cust PO</th>
                <th className="sticky bg-slate-700 px-2 py-2 whitespace-nowrap text-white opacity-100" style={{ left: `${left[2]}px` }}>Status</th>
                <th className="sticky bg-slate-600 px-2 py-2 whitespace-nowrap text-white opacity-100" style={{ left: `${left[3]}px` }}>Type</th>
                <th title="Arrow PO status flag (PORMAST.STATUS_FLAG): O = open, Q = quote. Closed/cancelled POs never reach this page." className="sticky bg-slate-600 px-2 py-2 whitespace-nowrap text-white border-r border-slate-500 opacity-100" style={{ left: `${left[4]}px` }}>Arrow</th>
                <th className="sticky bg-emerald-200 px-2 py-2 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: `${left[5]}px` }}>Stock code</th>
                <th className="sticky bg-emerald-200 px-2 py-2 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: `${left[6]}px` }}>Supplier SKU</th>
                <th title="PO order date" className="sticky bg-emerald-200 px-2 py-2 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: `${left[7]}px` }}>Order dt</th>
                <th title="Date keyed on the Arrow PO — reference only, not a forecast" className="sticky bg-emerald-200 px-2 py-2 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: `${left[8]}px` }}>ETA</th>
                <th title="Qty ordered in Arrow" className="sticky bg-emerald-200 px-2 py-2 text-right whitespace-nowrap text-emerald-900 opacity-100" style={{ left: `${left[9]}px` }}>Qty</th>
                <th title="Qty received in Arrow" className="sticky bg-emerald-200 px-2 py-2 text-right whitespace-nowrap text-emerald-900 opacity-100" style={{ left: `${left[10]}px` }}>Rcvd</th>
                <th title="Stock on hand in Arrow, all locations (hover for allocated / backordered)" className="sticky bg-emerald-200 px-2 py-2 text-right whitespace-nowrap text-emerald-900 border-r-2 border-emerald-400 opacity-100" style={{ left: `${left[11]}px` }}>SOH</th>
                {supplierOpen ? (<>
                <th title="Matched AS400 PO / item" className="bg-[#fef3c7] px-2 py-2 whitespace-nowrap text-[#78350f] opacity-100">Arrow PO</th>
                <th className="bg-[#fef3c7] px-2 py-2 text-right whitespace-nowrap text-[#78350f] opacity-100">ENT</th>
                <th className="bg-[#fef3c7] px-2 py-2 text-right whitespace-nowrap text-[#78350f] opacity-100">SHPD</th>
                <th title="AS400 ship date" className="bg-[#fef3c7] px-2 py-2 whitespace-nowrap text-[#78350f] opacity-100">Ship dt</th>
                <th className="bg-[#fef3c7] px-2 py-2 whitespace-nowrap text-[#78350f] opacity-100">ETA</th>
                <th className="bg-[#fef3c7] px-2 py-2 whitespace-nowrap text-[#78350f] border-r-2 border-[#fcd34d] opacity-100">US SO#</th>
                </>) : (
                <th title="AS400 match (click the orange header to expand)" className="bg-[#fef3c7] px-1 py-2 text-center whitespace-nowrap text-[#78350f] border-r-2 border-[#fcd34d] opacity-100">AS400</th>
                )}
                <th title="Qty shipped, not yet received" className="bg-violet-100 px-2 py-2 text-right whitespace-nowrap text-violet-900 opacity-100">On water</th>
                <th className="bg-violet-100 px-2 py-2 whitespace-nowrap text-violet-900 opacity-100">Container</th>
                <th className="bg-violet-100 px-2 py-2 whitespace-nowrap text-violet-900 opacity-100">Vessel</th>
                <th title="Container ETA (CDS-Net)" className="bg-violet-100 px-2 py-2 whitespace-nowrap text-violet-900 opacity-100">Cont ETA</th>
                <th className="bg-violet-100 px-2 py-2 whitespace-nowrap text-violet-900 opacity-100">Supplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="py-12 text-center text-slate-400">
                    No rows match the current filter.
                  </td>
                </tr>
              ) : (
                filtered.map((r, i) => {
                  const addr = addrMatch(r);
                  const rowBase = r.status === 'received' ? 'opacity-60' : '';
                  // container tracking for this line: by supplier SKU, else by the AS400 item code, else PO-level
                  const lineCts = ctIdx.byLine.get(ctLineKey(r.po, r.supplierSku))
                    ?? (r.as400Item ? ctIdx.byLine.get(ctLineKey(r.po, r.as400Item)) : undefined) ?? [];
                  const poCts = ctIdx.byPo.get(r.po) ?? [];
                  // US lane: Dimi registers boxes on ShipsGo with the Hayward US sales-order numbers in the reference
                  // ("Hayward PO: 600509068, 070, 071"). AS400 gives each line its US SO#, so that is an exact link.
                  const soCts = !lineCts.length && r.usSoNumber ? ctIdx.bySo.get(r.usSoNumber.replace(/^0+/, '')) ?? [] : [];
                  const matched = soCts.map((c) => ({ c, why: `US SO ${r.usSoNumber} named in the ShipsGo reference` }));
                  // A box whose only knowledge is "this PO" (CHR/ShipsGo booking ref, no item detail from any
                  // document) is offered to every shipped line of the PO as a probable match.
                  const poLevelOnly = !lineCts.length && r.onWater > 0
                    ? poCts.filter((c) => !c.lines.length).map((c) => ({ c, why: `${c.sources.includes('chr') ? 'CHR' : 'ShipsGo'} booking names PO ${r.po} but carries no item detail` }))
                    : [];
                  const probable = !lineCts.length && !soCts.length ? [...poLevelOnly, ...(!poCts.length ? probableFor(r) : [])] : [];
                  const hasTracking = lineCts.length > 0 || soCts.length > 0 || poCts.length > 0 || probable.length > 0;
                  // Chip follows the same container the Vessel / Cont ETA columns show: the latest-ETA box
                  // (reconcile() picks that one), so a split shipment reads "Empty to shipper · EVER SMART · 21 Nov", not a mix.
                  const shownCts = lineCts.length ? lineCts : soCts;
                  const chipCt = shownCts.length
                    ? [...shownCts].sort((a, b) => (bestEta(b) ?? '').localeCompare(bestEta(a) ?? ''))[0]
                    : undefined;
                  const rowKey = `${r.po}|${r.arrowStock}|${i}`;
                  const isOpen = expanded.has(rowKey);
                  return (
                    <Fragment key={rowKey}>
                    <tr
                      className={`${rowBase} hover:brightness-[0.97] transition-colors ${hasTracking ? 'cursor-pointer' : ''}`}
                      title={hasTracking ? (isOpen ? 'Click to hide the container' : 'Click to show the container') : undefined}
                      onClick={(e) => { if (hasTracking && !(e.target as HTMLElement).closest('a')) toggleRow(rowKey); }}
                    >
                      <td className="sticky left-0 z-10 bg-slate-900 px-2 py-1.5 whitespace-nowrap">
                        <Link href={`/dashboard/reconciliation?po=${r.po}`} className="font-bold text-white hover:text-wave">{r.po}</Link>
                      </td>
                      <td className="sticky bg-slate-800 px-2 py-1.5 font-mono text-[11px] whitespace-nowrap text-slate-200" style={{ left: `${left[1]}px` }}>{r.deliveryNote4 || '—'}</td>
                      <td className="sticky bg-slate-800 px-2 py-1.5" style={{ left: `${left[2]}px` }}>
                        {r.stale
                          ? <span className="inline-block rounded bg-slate-500 px-2 py-0.5 text-[11px] font-semibold text-white" title={`${r.status === 'missing' ? 'Missing in AS400' : 'Awaiting ship'} — stale: ${r.daysOpen} days open, nothing shipped or received, no future AS400 ETA. ${STALE_WHY[r.stale]}`}>Stale {r.daysOpen}d</span>
                          : statusBadge(r.status)}
                      </td>
                      <td className="sticky bg-slate-700 px-2 py-1.5" style={{ left: `${left[3]}px` }}>
                        {supplierTypeBadge(r.creditor, r.stockCategory)}
                      </td>
                      <td className="sticky bg-slate-700 px-2 py-1.5 border-r border-slate-600 text-center font-mono text-[11px]" style={{ left: `${left[4]}px` }}
                          title={r.poStatus == null ? 'Arrow PO status not in this sync yet — update arrow-recon.js / arrow-open-pos.sql' : PO_STATUS_LABEL[r.poStatus] ?? `Arrow STATUS_FLAG "${r.poStatus}"`}>
                        {r.poStatus == null ? <span className="text-slate-500">·</span>
                          : r.poStatus === 'O' ? <span className="text-emerald-300">Open</span>
                          : r.poStatus === '' ? <span className="text-slate-400">—</span>
                          : <span className="text-amber-300">{r.poStatus}</span>}
                      </td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 font-mono text-[11px] whitespace-nowrap text-slate-800" style={{ left: `${left[5]}px` }}>{r.arrowStock}</td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 font-mono text-[11px] whitespace-nowrap text-slate-700" style={{ left: `${left[6]}px` }}>{r.supplierSku || '—'}</td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 whitespace-nowrap text-slate-500" style={{ left: `${left[7]}px` }}>{fmt(r.orderDate)}</td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 whitespace-nowrap text-slate-700" style={{ left: `${left[8]}px` }}>
                        {fmt(r.requestedDate)}
                      </td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 text-right font-bold text-emerald-900" style={{ left: `${left[9]}px` }}>{r.qtyOrdered}</td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 text-right text-slate-600" style={{ left: `${left[10]}px` }}>{r.qtyReceived}</td>
                      <td className="sticky bg-emerald-50 px-2 py-1.5 text-right border-r-2 border-emerald-300" style={{ left: `${left[11]}px` }}
                          title={r.onHand != null ? `On hand ${r.onHand} · allocated ${r.allocated ?? 0} · backordered ${r.backordered ?? 0}` : 'No stock record'}>
                        {r.onHand == null ? <span className="text-slate-300">—</span>
                          : r.onHand <= 0 ? <span className="font-semibold text-rose-600">{r.onHand}</span>
                          : (r.backordered ?? 0) > 0 ? <span className="font-semibold text-amber-700">{r.onHand}</span>
                          : <span className="text-slate-700">{r.onHand}</span>}
                      </td>
                      {supplierOpen ? (<>
                      <td className="bg-[#fffbeb] px-2 py-1.5 whitespace-nowrap font-mono text-[11px]">
                        {!r.matchType
                          ? <span className="text-red-400">—</span>
                          : r.matchType === 'alias'
                            ? <span className="text-[#b45309] font-semibold" title={`SKU differs — supplier entered ${r.as400Item}. Matched on PO + qty. Fix STKMAST.SUPPLIER_STOCK.`}>&#8776; {r.as400Item}</span>
                            : <span className="text-green-700 font-semibold">&#10003; {r.po}</span>
                        }
                      </td>
                      <td className="bg-[#fffbeb] px-2 py-1.5 text-right">
                        {!r.matchType
                          ? <span className="font-semibold text-red-600">missing</span>
                          : r.qtyMismatch
                            ? <span className="rounded bg-red-100 px-1.5 font-semibold text-red-700" title={`Arrow ordered ${r.qtyOrdered}, supplier entered ${r.as400Ord}`}>{r.as400Ord}</span>
                            : <span className="font-semibold text-[#78350f]">{r.as400Ord}</span>}
                      </td>
                      <td className="bg-[#fffbeb] px-2 py-1.5 text-right text-[#92400e]">{r.as400Shpd || '—'}</td>
                      <td className="bg-[#fffbeb] px-2 py-1.5 whitespace-nowrap text-slate-600">
                        {fmt(r.shipDate)}
                        {r.shipDateOverdue && <span className="ml-1 text-amber-600" title="AS400 ship date has passed but nothing has shipped (SHPD 0, no container)">⏱</span>}
                      </td>
                      <td className="bg-[#fffbeb] px-2 py-1.5 whitespace-nowrap text-slate-600">{fmt(r.as400Eta)}</td>
                      <td className="bg-[#fffbeb] px-2 py-1.5 font-mono text-[11px] text-slate-500 border-r-2 border-[#fde68a]"><span title={r.usSoNumber ?? ''}>{r.usSoNumber ?? '—'}</span></td>
                      </>) : (
                      <td className="bg-[#fffbeb] px-1 py-1.5 text-center border-r-2 border-[#fde68a]"
                          title={!r.matchType ? 'Not entered by supplier' : `AS400 ${r.po}: entered ${r.as400Ord}, shipped ${r.as400Shpd || 0}${r.shipDate ? `, ship date ${fmt(r.shipDate)}` : ''}${r.usSoNumber ? ` · US SO ${r.usSoNumber}` : ''}${r.qtyMismatch ? ' · QTY MISMATCH' : ''}`}>
                        {!r.matchType ? <span className="font-semibold text-red-600">✗</span>
                          : r.qtyMismatch ? <span className="font-semibold text-red-700">≠</span>
                          : r.matchType === 'alias' ? <span className="text-[#b45309]">≈</span>
                          : <span className="text-green-700">✓</span>}
                      </td>
                      )}
                      <td className="bg-violet-50 px-2 py-2 text-center">
                        {r.onWater > 0
                          ? <span className="font-bold text-violet-700">{r.onWater}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="bg-violet-50 px-2 py-1.5 whitespace-nowrap text-violet-800">
                        {hasTracking ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleRow(rowKey); }}
                            title={isOpen ? 'Hide tracking' : shownCts.length
                              ? `Show tracking (${shownCts.length} container${shownCts.length === 1 ? '' : 's'} carrying this line${soCts.length ? ` — matched by US SO ${r.usSoNumber}` : ''})`
                              : `${poCts.length} container${poCts.length === 1 ? '' : 's'} on PO ${r.po} carry other lines — this line isn't confirmed in any yet`}
                            className="flex w-full items-center gap-1 text-left hover:text-violet-950"
                          >
                            <span className="text-[10px] text-violet-400">{isOpen ? '▾' : '▸'}</span>
                            <span className="truncate font-mono text-[11px]" title={r.container ?? ''}>
                              {shownCts.length > 1 && chipCt ? `${chipCt.containerNo} +${shownCts.length - 1}`
                                : soCts.length ? soCts[0].containerNo
                                : r.container ?? (probable.length ? `≈ ${probable[0].c.containerNo}${probable.length > 1 ? ` +${probable.length - 1}` : ''}`
                                : poCts.length ? `${poCts.length} box${poCts.length === 1 ? '' : 'es'} · other lines` : '—')}
                            </span>
                            {(chipCt ?? probable[0]?.c) && <span className="ml-auto shrink-0"><StatusChip c={chipCt ?? probable[0].c} /></span>}
                          </button>
                        ) : (
                          <span title={r.container ?? ''}>{r.container ?? '—'}</span>
                        )}
                      </td>
                      <td className="bg-violet-50 px-2 py-1.5 whitespace-nowrap text-slate-700">
                        <span title={r.vessel ?? bestVessel((chipCt ?? probable[0]?.c) ?? ({} as CtContainer)) ?? ''}>{r.vessel ?? ((chipCt ?? probable[0]?.c) ? bestVessel((chipCt ?? probable[0]?.c)!) : null) ?? '—'}</span>
                      </td>
                      <td className="bg-violet-50 px-2 py-1.5 whitespace-nowrap text-slate-600">
                        {fmt(r.containerEta ?? ((chipCt ?? probable[0]?.c) ? bestEta((chipCt ?? probable[0]?.c)!) : null))}
                        {chipCt?.live?.previousEta && chipCt.live.eta && chipCt.live.previousEta < chipCt.live.eta && (
                          <span className="ml-1 text-rose-600" title={`ETA slipped — was ${fmt(chipCt.live.previousEta)}`}>▲</span>
                        )}
                      </td>
                      <td className="bg-violet-50 px-2 py-1.5 whitespace-nowrap text-slate-500">
                        {creditorName[r.creditor ?? ''] ?? r.creditor ?? '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-violet-50/40">
                        <td colSpan={colCount} className="p-0" style={{ whiteSpace: 'normal' }}>
                          <TrackingPanel po={r.po} item={r.as400Item ?? r.supplierSku} lineContainers={lineCts} poContainers={poCts} probable={probable} matched={matched} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        </div>
        </>
      )}

      <p className="text-xs text-ink/40">
        {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} lines shown
      </p>

      {/* ── Upload banners — bottom of page ── */}
      <div id="uploads" className="flex items-center justify-between pt-4 border-t border-slate-100" style={{ scrollMarginTop: '96px' }}>
        <h2 className="text-sm font-semibold text-slate-700">Uploads</h2>
        <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="text-xs text-slate-500 hover:text-slate-800">↑ Back to top</button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <UploadBanner
          label="Container documents"
          sublabel="Century CSV · CHR report · Shipment Schedule · Wuxi Shipment Forecast · invoices · packing slips · .msg"
          hint="Drop the Century/VIZIV dashboard CSV (all containers shipped to AU/NZ), the C.H. Robinson 'Hayward Pool Shipment Activity Report' xlsx from Navisphere (US lane), Dimi's Shipment Schedule.xlsx (revised delivery dates, customer notes, invoice→PO links), the Wuxi Shipment Forecast.xlsx (customer-direct containers, PO→SO links for the Container orders page), the PDFs from sbateman@hayward.com (Inv#: … PO: …) and robot@hayward.com (Hayward Shipment for PO: …), the CDS-Net xlsx, or whole emails saved as .msg from Dimi's mailbox. Container numbers are read from the documents, matched to the PO lines, and tracked on ShipsGo. The AU Containers mailbox flow does this automatically once it's live."
          meta={ctInfo.meta?.lastCenturyAt ? `Century ${fmtMeta(ctInfo.meta.lastCenturyAt)} · ${ctContainers.length} open containers` : ctInfo.meta?.lastIngestAt ? `last: ${fmtMeta(ctInfo.meta.lastIngestAt)} · ${ctInfo.meta.lastSubject ?? ''}`.slice(0, 90) : 'nothing ingested yet'}
          uploading={uploadingDocs}
          accept=".pdf,.msg,.xlsx,.xls,.csv"
          collapseHint
          multiple
          onFiles={handleDocFiles}
          note={docsNote}
        />
        <UploadBanner
          label="AS400 data"
          sublabel="manual until Snowflake service account is live"
          hint="Run the AS400 query in Snowsight, download as CSV or Excel, and drop it here. Columns: PO, ITEM, AS400_ORD, AS400_SHPD, ETA, SHIP_DATE, SHIP_TO_NAME, SHIP_TO_CITY, SHIP_TO_STATE, SHIP_TO_COUNTRY, SHIP_TO_POSTCODE, US_SO_NUMBER."
          meta={as400Meta.rows > 0 ? `${as400Meta.rows.toLocaleString()} lines · ${fmtMeta(as400Meta.uploadedAt) ?? ''} · ${as400Meta.filename ?? ''}` : 'not uploaded'}
          uploading={uploadingA4}
          accept=".csv,.xlsx,.xls"
          onFile={handleAs400File}
        />
      </div>
    </div>
  );
}
