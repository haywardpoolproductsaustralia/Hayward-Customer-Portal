'use client';

// app/dashboard/reconciliation/page.tsx
// Hidden scrollbar styles - removes scrollbars from both top and bottom
// while keeping scroll functionality intact
const SCROLLBAR_STYLE = `
  #top-scroll::-webkit-scrollbar,
  #bottom-scroll::-webkit-scrollbar { display: none; }
  #top-scroll { -ms-overflow-style: none; scrollbar-width: none; }
  #bottom-scroll { -ms-overflow-style: none; scrollbar-width: none; }
`;
// Full-width PO reconciliation: Arrow AU vs AS400 (Snowflake upload) vs CDS-Net shipments.
// Both AS400 data and CDS-Net shipment file can be uploaded directly in the browser.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArrowLine = {
  po: string;
  deliveryNote4: string;
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
  status: 'missing' | 'not_received' | 'shipped' | 'in_transit' | 'delivered' | 'ok';
  lateVsRequest: boolean;
  qtyMismatch: boolean;
  matchType: 'exact' | 'alias' | null;   // alias = matched on PO + qty because SKU codes differ
  as400Item: string | null;              // the supplier's own item code from AS400
  shipped: boolean;                      // supplier has shipped (SHPD > 0 or ship date reached)
  bestEta: string | null;                // container ETA, else AS400 ETA
};

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

function isException(x: ReconRow) {
  return x.status === 'missing' || x.qtyMismatch || x.matchType === 'alias' || x.lateVsRequest;
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
// Parse CDS-Net "Shipment Activity by Container" XLSX in the browser.
// Mirrors the logic in shipment-load.js exactly.
// Uses SheetJS loaded from CDN via a dynamic script tag.
// ---------------------------------------------------------------------------

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

function isoDate(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Excel serial number
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function parseShipmentXlsx(file: File): Promise<ShipLine[]> {
  const XLSX = await loadSheetJS();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  // The CDS-Net sheet may not be the first sheet — find whichever has a "PO #" header row.
  let raw: any[][] = [];
  let hi = -1;
  for (const name of wb.SheetNames) {
    const rowsOfSheet: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true });
    const idx = rowsOfSheet.findIndex((r: any[]) => Array.isArray(r) && r.some((v: any) => String(v ?? '').trim() === 'PO #'));
    if (idx >= 0) { raw = rowsOfSheet; hi = idx; break; }
  }
  if (hi < 0) throw new Error('Column "PO #" not found — is this a Shipment Activity by Container file?');

  const H = raw[hi];
  // Normalize headers: trim whitespace and match case-insensitively
  const normalizeHeader = (h: any) => (h ? String(h).trim() : '');
  const colIndex = (name: string) => {
    const normalized = name.trim().toLowerCase();
    return H.findIndex((h: any) => normalizeHeader(h).toLowerCase() === normalized);
  };
  
  const c = {
    po:            colIndex('PO #'),
    item:          colIndex('Item #'),
    container:     colIndex('Container #'),
    vessel:        colIndex('Vessel'),
    etd:           colIndex('ETD'),
    eta:           colIndex('ETA'),
    delivered:     colIndex('Delivered'),
    actualDeliv:   colIndex('Actual Delivered Date'),
    units:         colIndex('Units'),
    carrier:       colIndex('Carrier Name'),
    origin:        colIndex('Origin Port Name'),
    destPort:      colIndex('Dest. Port Name'),
    location:      colIndex('Location Name'),
  };

  // Verify required columns exist
  const missing = Object.entries(c)
    .filter(([k, idx]) => idx === -1 && ['po', 'item', 'destPort'].includes(k))
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Required columns not found: ${missing.join(', ')}`);
  }

  const lines: ShipLine[] = [];
  for (let i = hi + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!Array.isArray(r) || !r[c.po]) continue;
    const po = String(r[c.po]).trim();
    if (!/^\d{6}$/.test(po)) continue;
    const destPort = r[c.destPort] != null ? String(r[c.destPort]).trim() : '';
    if (!destPort || !AUNZ_PORTS.has(destPort.toLowerCase())) continue;
    const item = r[c.item] != null ? String(r[c.item]).trim() : '';
    if (!item) continue;
    lines.push({
      po, item,
      container: c.container !== -1 && r[c.container] != null ? String(r[c.container]).trim() || null : null,
      vessel:    c.vessel !== -1 && r[c.vessel]    != null ? String(r[c.vessel]).trim()    || null : null,
      etd:       c.etd !== -1 ? isoDate(r[c.etd]) : null,
      eta:       c.eta !== -1 ? isoDate(r[c.eta]) : null,
      delivered: (c.delivered !== -1 ? isoDate(r[c.delivered]) : null) ?? (c.actualDeliv !== -1 ? isoDate(r[c.actualDeliv]) : null),
      units:     c.units !== -1 && r[c.units] != null && r[c.units] !== '' ? Number(r[c.units]) : null,
      carrier:   c.carrier !== -1 && r[c.carrier] != null ? String(r[c.carrier]).trim() || null : null,
      origin:    c.origin !== -1 && r[c.origin]  != null ? String(r[c.origin]).trim()  || null : null,
      destPort,
    });
  }
  return lines;
}

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
    const shipped = !!a4 && (as400Shpd > 0 || (!!a4.shipDate && a4.shipDate <= today));
    const onWater = !shipped ? 0
      : as400Shpd > 0 ? Math.max(0, as400Shpd - a.qtyReceived)
      : a.qtyOutstanding;

    let status: ReconRow['status'] = 'ok';
    if (!a4)                       status = 'missing';
    else if (latest?.delivered)    status = 'delivered';
    else if (latest)               status = 'in_transit';
    else if (shipped)              status = 'shipped';
    else if (a.qtyOutstanding > 0) status = 'not_received';

    const qtyMismatch = !!a4 && Math.round(as400Ord) !== Math.round(a.qtyOrdered);
    const bestEta = latest?.eta ?? a4?.eta ?? null;
    const lateVsRequest = !!(a.requestedDate && bestEta && bestEta > a.requestedDate && a.qtyOutstanding > 0);

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
      bestEta,
    };
  });
}

// ---------------------------------------------------------------------------
// Upload banner component (reused for both AS400 and Shipment)
// ---------------------------------------------------------------------------

function UploadBanner({
  label, sublabel, hint, meta, uploading, accept, onFile,
}: {
  label: string;
  sublabel: string;
  hint: string;
  meta: string;
  uploading: boolean;
  accept: string;
  onFile: (f: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">{label} {meta && <span className="font-normal text-slate-400">· {meta}</span>}</span>
        <span className="shrink-0 text-xs text-slate-400">{sublabel}</span>
      </div>
      <p className="mb-3 text-xs text-slate-500">{hint}</p>
      <input
        ref={ref} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
      <button
        onClick={() => ref.current?.click()}
        disabled={uploading}
        className="inline-flex items-center gap-2 rounded-lg bg-wave px-4 py-2 text-sm font-medium text-white hover:bg-deep disabled:opacity-60"
      >
        {uploading ? 'Processing…' : '↑ Choose file'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'exceptions' | 'not_received' | 'shipped' | 'in_transit' | 'delivered';

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
  const [uploadingShip, setUploadingShip] = useState(false);
  const [showParamount,    setShowParamount]    = useState(false);
  const [selectedCustomerPO, setSelectedCustomerPO] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/recon/arrow').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recon/shipment').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recon/as400').then((r) => r.json()).catch(() => ({})),
    ]).then(([arrow, ship, a400]) => {
      setArrowLines(arrow.lines ?? []);
      setArrowMeta({ generatedAt: arrow.generatedAt ?? null, rows: arrow.lines?.length ?? 0 });
      setShipLines(ship.lines ?? []);
      setShipMeta({ receivedAt: ship.receivedAt ?? null, rows: ship.lines?.length ?? 0, filename: ship.filename ?? ship.subject ?? null });
      setAs400Lines(a400.lines ?? []);
      setAs400Meta({ uploadedAt: a400.uploadedAt ?? null, rows: a400.lines?.length ?? 0, filename: a400.filename ?? null });
    }).finally(() => setLoading(false));
  }, []);

  // Auto-enable Paramount button if user only has access to Paramount POs
  // (i.e., they receive only PR stock category from API - like Poolwater Products)
  useEffect(() => {
    if (arrowLines.length === 0) return;
    const hasParamount = arrowLines.some((l) => l.stockCategory === 'PR');
    const hasNonParamount = arrowLines.some((l) => l.stockCategory !== 'PR');
    if (hasParamount && !hasNonParamount) {
      setShowParamount(true);
    }
  }, [arrowLines]);

  // Clear selectedCustomerPO when Paramount is turned off
  useEffect(() => {
    if (!showParamount) {
      setSelectedCustomerPO(null);
    }
  }, [showParamount]);

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

  // CDS-Net shipment XLSX upload — parsed entirely in the browser
  const handleShipFile = useCallback(async (file: File) => {
    setUploadingShip(true);
    try {
      const lines = await parseShipmentXlsx(file);
      if (!lines.length) { alert('No AU/NZ lines found. Check the file is "Shipment Activity by Container" from CDS-Net and contains AU destination ports.'); return; }
      const meta = { receivedAt: new Date().toISOString(), rows: lines.length, filename: file.name };
      const res = await fetch('/api/recon/shipment-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines, ...meta }),
      });
      if (!res.ok) throw new Error(await res.text());
      setShipLines(lines);
      setShipMeta(meta);
    } catch (e: any) {
      alert('Shipment upload failed: ' + e.message);
    } finally {
      setUploadingShip(false);
    }
  }, []);

  const rows = useMemo(() => reconcile(arrowLines, as400Lines, shipLines), [arrowLines, as400Lines, shipLines]);

  const filtered = useMemo(() => {
    let r = rows;
    // When Paramount button is active, show ONLY Paramount (PR). Otherwise exclude it.
    if (showParamount)
      r = r.filter((x) => x.stockCategory === 'PR');
    else
      r = r.filter((x) => x.stockCategory !== 'PR');
    if (selectedCustomerPO) {
      r = r.filter((x) => x.deliveryNote4 === selectedCustomerPO);
    }
    if (tab === 'exceptions')   r = r.filter(isException);
    if (tab === 'not_received') r = r.filter((x) => x.status === 'not_received');
    if (tab === 'shipped')      r = r.filter((x) => x.status === 'shipped');
    if (tab === 'in_transit')   r = r.filter((x) => x.status === 'in_transit');
    if (tab === 'delivered')    r = r.filter((x) => x.status === 'delivered');
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
        (x.shipToName ?? '').toLowerCase().includes(q) ||
        (x.shipToCity ?? '').toLowerCase().includes(q),
      );
    }
    return r;
  }, [rows, tab, search, showParamount, selectedCustomerPO]);

  const stats = useMemo(() => {
    const scope = rows.filter((x) => (showParamount ? x.stockCategory === 'PR' : x.stockCategory !== 'PR'));
    return {
      total:      scope.length,
      exceptions: scope.filter(isException).length,
      missing:    scope.filter((x) => x.status === 'missing').length,
      awaiting:   scope.filter((x) => x.status === 'not_received').length,
      shipped:    scope.filter((x) => x.status === 'shipped').length,
      inTransit:  scope.filter((x) => x.status === 'in_transit').length,
      delivered:  scope.filter((x) => x.status === 'delivered').length,
      late:       scope.filter((x) => x.lateVsRequest).length,
    };
  }, [rows, showParamount]);

  // Data freshness — warn when any source is out of date
  const staleWarnings = useMemo(() => {
    const ageH = (d: string | null) => (d ? (Date.now() - new Date(d).getTime()) / 3_600_000 : Infinity);
    const w: string[] = [];
    if (ageH(arrowMeta.generatedAt) > 24) w.push(`Arrow POs last synced ${arrowMeta.generatedAt ? new Date(arrowMeta.generatedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'never'} — check arrow-recon.js is scheduled on AZ-Grey`);
    if (ageH(as400Meta.uploadedAt) > 72) w.push(`AS400 data uploaded ${as400Meta.uploadedAt ? new Date(as400Meta.uploadedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'never'} — upload a fresh export below`);
    if (ageH(shipMeta.receivedAt) > 72) w.push(`CDS-Net shipment file uploaded ${shipMeta.receivedAt ? new Date(shipMeta.receivedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'never'} — upload today's file below`);
    return w;
  }, [arrowMeta, as400Meta, shipMeta]);

  // Get unique customer POs when Paramount is enabled
  const paramountCustomerPOs = useMemo(() => {
    if (!showParamount) return [];
    const pos = new Set(
      rows
        .filter((x) => x.stockCategory === 'PR' && x.deliveryNote4)
        .map((x) => x.deliveryNote4)
    );
    return Array.from(pos).sort();
  }, [rows, showParamount]);

  const fmtMeta = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

  const tabs: { id: FilterTab; label: string; count?: number }[] = [
    { id: 'all',          label: 'All',           count: stats.total },
    { id: 'exceptions',   label: 'Exceptions',    count: stats.exceptions },
    { id: 'not_received', label: 'Awaiting ship', count: stats.awaiting },
    { id: 'shipped',      label: 'Shipped · no container', count: stats.shipped },
    { id: 'in_transit',   label: 'In transit',    count: stats.inTransit },
    { id: 'delivered',    label: 'Delivered',      count: stats.delivered },
  ];

  return (
    <div className="space-y-6">
      <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_STYLE }} />

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <span className="text-wave">⚓</span> Order Reconciliation &amp; ETA
          </h1>
          <p className="text-sm text-slate-500">Arrow POs vs AS400 supplier entry vs CDS-Net shipment portal · Australia &amp; New Zealand</p>
          <div className="mt-1 flex gap-3 text-xs text-slate-400">
            {arrowMeta.generatedAt && <span>{arrowMeta.rows} Arrow · {fmtMeta(arrowMeta.generatedAt)}</span>}
            {as400Meta.rows > 0    && <span>· {as400Meta.rows} AS400</span>}
            {shipMeta.rows > 0     && <span>· {shipMeta.rows} shipment lines</span>}
          </div>
        </div>
      </div>

      {staleWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <p className="mb-1 font-semibold">Some data is out of date — figures below may be wrong</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {staleWarnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* ── KPI cards — hidden when scrolled (sticky bar takes over) ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 transition-all duration-200 overflow-hidden"
           style={{ maxHeight: '120px' }}
           ref={(el) => {
             if (!el) return;
             const onScroll = () => {
               el.style.maxHeight = window.scrollY > 80 ? '0px' : '120px';
               el.style.opacity = window.scrollY > 80 ? '0' : '1';
               el.style.marginBottom = window.scrollY > 80 ? '-1.5rem' : '';
             };
             window.addEventListener('scroll', onScroll, { passive: true });
           }}
      >
        {[
          { label: 'PO Lines',        value: stats.total,      color: 'text-ink' },
          { label: 'Exceptions',      value: stats.exceptions,  color: 'text-amber-600' },
          { label: 'In Transit',      value: stats.inTransit + stats.shipped, color: 'text-blue-600' },
          { label: 'Delivered',       value: stats.delivered,   color: 'text-green-700' },
          { label: 'Late vs request', value: stats.late,        color: 'text-red-600' },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-slate-100 bg-white p-4">
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
            <p className="text-xs text-slate-500">{k.label}</p>
          </div>
        ))}
      </div>

      {/* ── Filter row — sticky below dashboard header ── */}
      <div className="sticky top-0 z-30 -mx-8 bg-white/95 backdrop-blur px-8 py-3 border-b border-slate-100 shadow-sm flex flex-wrap items-center gap-2">
        {/* Stock group toggles — LEFT */}
        <div className="flex gap-2 mr-4">
          <button
            onClick={() => setShowParamount((v) => !v)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
              showParamount
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-white text-slate-500 border-slate-200 hover:border-purple-400 hover:text-purple-600'
            }`}
          >
            {showParamount ? '✓' : '+'} Paramount
          </button>
        </div>

        {/* Search and tabs — CENTER */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search PO, SKU, description, supplier code or name…"
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

        {/* Customer PO buttons — RIGHT (only visible when Paramount is on) */}
        {showParamount && paramountCustomerPOs.length > 0 && (
          <div className="ml-auto flex flex-wrap gap-1 justify-end">
            {paramountCustomerPOs.map((po) => (
              <button
                key={po}
                onClick={() => setSelectedCustomerPO(selectedCustomerPO === po ? null : po)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium border transition-colors ${
                  selectedCustomerPO === po
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-purple-300 hover:text-purple-600'
                }`}
              >
                {po}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="py-16 text-center text-sm text-slate-400">Loading…</div>
      ) : (
        <>
          {/* Export button — right-aligned above table */}
          <div className="flex justify-end mb-2">
            <button
              onClick={() => {
                const headers = [
                  'PO','Customer PO','Status','Type','Stock Code','Supplier SKU','Order Date','ETA Arrow',
                  'Ordered','Received','Arrow PO Ref','AS400 Item','Match','AS400 ENT','AS400 SHPD','Qty Mismatch','Ship Date','AS400 ETA','US SO#',
                  'On Water','Container','Vessel','Container ETA','Supplier'
                ];
                const escape = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const csvRows = filtered.map(r => [
                  r.po, r.deliveryNote4 ?? '', r.status, HAYWARD_CREDITORS.has(r.creditor ?? '') ? 'Hayward' : '3rd Party',
                  r.arrowStock, r.supplierSku, r.orderDate ?? '', r.requestedDate ?? '',
                  r.qtyOrdered, r.qtyReceived,
                  r.matchType ? r.po : '', r.as400Item ?? '', r.matchType ?? 'missing',
                  r.matchType ? r.as400Ord : 'missing', r.as400Shpd, r.qtyMismatch ? 'YES' : '',
                  r.shipDate ?? '', r.as400Eta ?? '', r.usSoNumber ?? '',
                  r.onWater, r.container ?? '', r.vessel ?? '', r.containerEta ?? '',
                  creditorName[r.creditor ?? ''] ?? r.creditor ?? ''
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
          <div className="rounded-2xl border border-ink/10 bg-white shadow-soft overflow-hidden">
          {/* Top scrollbar mirror — synced to bottom scroll */}
          <div
            id="top-scroll"
            className="overflow-x-auto"
            style={{ height: '18px' }}
            onScroll={(e) => {
              const bottom = document.getElementById('bottom-scroll');
              if (bottom) bottom.scrollLeft = (e.target as HTMLDivElement).scrollLeft;
            }}
          >
            <div id="top-scroll-inner" style={{ height: '1px' }} />
          </div>
          {/* Actual scrollable table — fixed height so thead stays locked while tbody scrolls */}
          <div
            id="bottom-scroll"
            className="overflow-x-auto overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 220px)' }}
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
          <table className="w-full text-left text-xs" style={{ minWidth: '2400px', tableLayout: 'auto', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ minWidth: '75px' }}  />
              <col style={{ minWidth: '100px' }} />{/* Customer PO column added */}
              <col style={{ minWidth: '90px' }}  />
              <col style={{ minWidth: '90px' }}  />{/* Supplier type */}
              <col style={{ minWidth: '130px' }} />
              <col style={{ minWidth: '120px' }} />
              <col style={{ minWidth: '100px' }} />
              <col style={{ minWidth: '100px' }} />
              <col style={{ minWidth: '75px' }}  />
              <col style={{ minWidth: '75px' }}  />
              <col style={{ minWidth: '90px' }}  />
              <col style={{ minWidth: '70px' }}  />
              <col style={{ minWidth: '70px' }}  />
              <col style={{ minWidth: '100px' }} />
              <col style={{ minWidth: '100px' }} />
              <col style={{ minWidth: '130px' }} />
              <col style={{ minWidth: '160px' }} />
              <col style={{ minWidth: '130px' }} />
              <col style={{ minWidth: '90px' }}  />
              <col style={{ minWidth: '80px' }}  />
              <col style={{ minWidth: '80px' }}  />
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="text-[11px] font-bold uppercase tracking-widest">
                <th colSpan={4} style={{ background: '#334155', color: 'white', padding: '6px 12px', borderRight: '2px solid white', position: 'sticky', left: 0, zIndex: 11, opacity: 1 }}>
                  Order
                </th>
                <th colSpan={6} style={{ background: '#059669', color: 'white', padding: '6px 12px', borderRight: '2px solid white', opacity: 1 }}>
                  Arrow AU
                </th>
                <th colSpan={6} style={{ background: '#f59e0b', color: 'white', padding: '6px 12px', borderRight: '2px solid white', opacity: 1 }}>
                  Supplier USA-China
                </th>
                <th colSpan={5} style={{ background: '#7c3aed', color: 'white', padding: '6px 12px', opacity: 1 }}>
                  Shipment On Water
                </th>
              </tr>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide">
                <th className="sticky left-0 z-10 bg-slate-800 px-3 py-2.5 whitespace-nowrap text-white opacity-100">PO</th>
                <th className="sticky bg-slate-700 px-3 py-2.5 whitespace-nowrap text-white opacity-100" style={{ left: '75px' }}>Customer PO</th>
                <th className="sticky bg-slate-700 px-3 py-2.5 whitespace-nowrap text-white opacity-100" style={{ left: '175px' }}>Status</th>
                <th className="sticky bg-slate-600 px-3 py-2.5 whitespace-nowrap text-white border-r border-slate-500 opacity-100" style={{ left: '265px' }}>Type</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: '355px' }}>Stock code</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: '485px' }}>Supplier SKU</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: '605px' }}>Order date</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900 opacity-100" style={{ left: '705px' }}>ETA Arrow</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 text-right whitespace-nowrap text-emerald-900 opacity-100" style={{ left: '805px' }}>Ordered</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 text-right whitespace-nowrap text-emerald-900 border-r-2 border-emerald-400 opacity-100" style={{ left: '880px' }}>Received</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900 opacity-100">Arrow PO ref</th>
                <th className="bg-amber-100 px-3 py-2.5 text-right whitespace-nowrap text-amber-900 opacity-100">ENT</th>
                <th className="bg-amber-100 px-3 py-2.5 text-right whitespace-nowrap text-amber-900 opacity-100">SHPD</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900 opacity-100">Ship date</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900 opacity-100">ETA</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900 border-r-2 border-amber-300 opacity-100">US SO#</th>
                <th className="bg-violet-100 px-3 py-2.5 text-right whitespace-nowrap text-violet-900 opacity-100">On water</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900 opacity-100">Container</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900 opacity-100">Vessel</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900 opacity-100">Cont. ETA</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900 opacity-100">Supplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={21} className="py-12 text-center text-slate-400">
                    No rows match the current filter.
                  </td>
                </tr>
              ) : (
                filtered.map((r, i) => {
                  const addr = addrMatch(r);
                  const rowBase = r.lateVsRequest ? 'bg-red-50/30' : '';
                  return (
                    <tr
                      key={`${r.po}-${r.arrowStock}-${i}`}
                      className={`${rowBase} hover:brightness-[0.97] transition-colors`}
                    >
                      <td className="sticky left-0 z-10 bg-slate-900 px-3 py-2 whitespace-nowrap">
                        <Link href={`/dashboard/reconciliation?po=${r.po}`} className="font-bold text-white hover:text-wave">{r.po}</Link>
                      </td>
                      <td className="sticky bg-slate-800 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-slate-200" style={{ left: '75px' }}>{r.deliveryNote4 || '—'}</td>
                      <td className="sticky bg-slate-800 px-3 py-2" style={{ left: '175px' }}>
                        {statusBadge(r.status)}
                      </td>
                      <td className="sticky bg-slate-700 px-3 py-2 border-r border-slate-600" style={{ left: '265px' }}>
                        {supplierTypeBadge(r.creditor, r.stockCategory)}
                      </td>
                      <td className="sticky bg-emerald-50 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-slate-800" style={{ left: '355px' }}>{r.arrowStock}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-slate-700" style={{ left: '485px' }}>{r.supplierSku || '—'}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 whitespace-nowrap text-slate-500" style={{ left: '605px' }}>{fmt(r.orderDate)}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 whitespace-nowrap text-slate-700" style={{ left: '705px' }}>
                        {fmt(r.requestedDate)}
                        {r.lateVsRequest && <span className="ml-1 text-red-500" title="Late vs requested date">&#x26A0;</span>}
                      </td>
                      <td className="sticky bg-emerald-50 px-3 py-2 text-right font-bold text-emerald-900" style={{ left: '805px' }}>{r.qtyOrdered}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 text-right text-slate-600 border-r-2 border-emerald-300" style={{ left: '880px' }}>{r.qtyReceived}</td>
                      <td className="bg-amber-50 px-3 py-2 whitespace-nowrap font-mono text-[11px]">
                        {!r.matchType
                          ? <span className="text-red-400">—</span>
                          : r.matchType === 'alias'
                            ? <span className="text-amber-700 font-semibold" title={`SKU differs — supplier entered ${r.as400Item}. Matched on PO + qty. Fix STKMAST.SUPPLIER_STOCK.`}>&#8776; {r.as400Item}</span>
                            : <span className="text-green-700 font-semibold">&#10003; {r.po}</span>
                        }
                      </td>
                      <td className="bg-amber-50 px-3 py-2 text-right">
                        {!r.matchType
                          ? <span className="font-semibold text-red-600">missing</span>
                          : r.qtyMismatch
                            ? <span className="rounded bg-red-100 px-1.5 font-semibold text-red-700" title={`Arrow ordered ${r.qtyOrdered}, supplier entered ${r.as400Ord}`}>{r.as400Ord}</span>
                            : <span className="font-semibold text-amber-900">{r.as400Ord}</span>}
                      </td>
                      <td className="bg-amber-50 px-3 py-2 text-right text-amber-800">{r.as400Shpd || '—'}</td>
                      <td className="bg-amber-50 px-3 py-2 whitespace-nowrap text-slate-600">{fmt(r.shipDate)}</td>
                      <td className="bg-amber-50 px-3 py-2 whitespace-nowrap text-slate-600">{fmt(r.as400Eta)}</td>
                      <td className="bg-amber-50 px-3 py-2 font-mono text-[11px] text-slate-500 border-r-2 border-amber-200">{r.usSoNumber ?? '—'}</td>
                      <td className="bg-violet-50 px-2 py-2 text-center">
                        {r.onWater > 0
                          ? <span className="font-bold text-violet-700">{r.onWater}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="bg-violet-50 px-2 py-2 whitespace-nowrap text-violet-800">{r.container ?? '—'}</td>
                      <td className="bg-violet-50 px-3 py-2 whitespace-nowrap text-slate-700">{r.vessel ?? '—'}</td>
                      <td className="bg-violet-50 px-3 py-2 whitespace-nowrap text-slate-600">{fmt(r.containerEta)}</td>
                      <td className="bg-violet-50 px-3 py-2 whitespace-nowrap text-slate-500">
                        {creditorName[r.creditor ?? ''] ?? r.creditor ?? '—'}
                      </td>
                    </tr>
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
      <div className="grid gap-3 lg:grid-cols-2 pt-4 border-t border-slate-100">
        <UploadBanner
          label="AS400 data"
          sublabel="manual until Snowflake service account is live"
          hint="Run the AS400 query in Snowsight, download as CSV or Excel, and drop it here. Columns: PO, ITEM, AS400_ORD, AS400_SHPD, ETA, SHIP_DATE, SHIP_TO_NAME, SHIP_TO_CITY, SHIP_TO_STATE, SHIP_TO_COUNTRY, SHIP_TO_POSTCODE, US_SO_NUMBER."
          meta={as400Meta.rows > 0 ? `${as400Meta.rows.toLocaleString()} lines · ${fmtMeta(as400Meta.uploadedAt) ?? ''} · ${as400Meta.filename ?? ''}` : 'not uploaded'}
          uploading={uploadingA4}
          accept=".csv,.xlsx,.xls"
          onFile={handleAs400File}
        />
        <UploadBanner
          label="CDS-Net shipment file"
          sublabel="Shipment Activity by Container · NoReply@cds-net.com"
          hint='Save the "Shipment Activity by Container" Excel attachment from your daily CDS-Net email and drop it here. AU/NZ rows are filtered automatically by destination port.'
          meta={shipMeta.rows > 0 ? `${shipMeta.rows.toLocaleString()} AU/NZ lines · ${fmtMeta(shipMeta.receivedAt) ?? ''} · ${shipMeta.filename ?? ''}` : 'not uploaded'}
          uploading={uploadingShip}
          accept=".xlsx,.xls"
          onFile={handleShipFile}
        />
      </div>
    </div>
  );
}
