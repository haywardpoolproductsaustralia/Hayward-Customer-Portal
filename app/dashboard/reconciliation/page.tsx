'use client';

// app/dashboard/reconciliation/page.tsx
// Chunky scrollbar styles injected at runtime so they apply to both
// the top mirror div and the bottom table scroll container.
const SCROLLBAR_STYLE = `
  #top-scroll::-webkit-scrollbar,
  #bottom-scroll::-webkit-scrollbar { height: 28px; }
  #top-scroll::-webkit-scrollbar-track,
  #bottom-scroll::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 99px; }
  #top-scroll::-webkit-scrollbar-thumb,
  #bottom-scroll::-webkit-scrollbar-thumb {
    background: #94a3b8;
    border-radius: 99px;
    border: 5px solid #f1f5f9;
    min-width: 80px;
  }
  #top-scroll::-webkit-scrollbar-thumb:hover,
  #bottom-scroll::-webkit-scrollbar-thumb:hover { background: #64748b; }
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
  arrowStock: string;
  supplierSku: string;
  description: string | null;
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
  status: 'missing' | 'not_received' | 'in_transit' | 'delivered' | 'ok';
  lateVsRequest: boolean;
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

function supplierTypeBadge(creditor: string | null) {
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
    not_received: { label: 'Not rcvd',    cls: 'bg-orange-400 text-white' },
    in_transit:   { label: 'In transit',  cls: 'bg-blue-500 text-white' },
    delivered:    { label: 'Delivered',   cls: 'bg-green-500 text-white' },
    ok:           { label: 'OK',          cls: 'bg-slate-400 text-white' },
  };
  const { label, cls } = map[s];
  return <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
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
  const lines = text.trim().split('\n');
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
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  const hi = raw.findIndex((r: any[]) => Array.isArray(r) && r.includes('PO #'));
  if (hi < 0) throw new Error('Column "PO #" not found — is this a Shipment Activity by Container file?');

  const H = raw[hi];
  const col = (n: string) => H.indexOf(n);
  const c = {
    po:            col('PO #'),
    item:          col('Item #'),
    container:     col('Container #'),
    vessel:        col('Vessel'),
    etd:           col('ETD'),
    eta:           col('ETA'),
    delivered:     col('Delivered'),
    actualDeliv:   col('Actual Delivered Date'),
    units:         col('Units'),
    carrier:       col('Carrier Name'),
    origin:        col('Origin Port Name'),
    destPort:      col('Dest. Port Name'),
    location:      col('Location Name'),
  };

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
      container: r[c.container] != null ? String(r[c.container]).trim() || null : null,
      vessel:    r[c.vessel]    != null ? String(r[c.vessel]).trim()    || null : null,
      etd:       isoDate(r[c.etd]),
      eta:       isoDate(r[c.eta]),
      delivered: isoDate(r[c.delivered]) ?? isoDate(r[c.actualDeliv]),
      units:     r[c.units] != null && r[c.units] !== '' ? Number(r[c.units]) : null,
      carrier:   r[c.carrier] != null ? String(r[c.carrier]).trim() || null : null,
      origin:    r[c.origin]  != null ? String(r[c.origin]).trim()  || null : null,
      destPort,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Reconcile Arrow + AS400 + Shipment
// ---------------------------------------------------------------------------

function reconcile(arrow: ArrowLine[], as400: As400Line[], ship: ShipLine[]): ReconRow[] {
  const a4Map = new Map<string, As400Line>();
  for (const r of as400) {
    const key = `${r.po}-${r.item}`;
    const ex = a4Map.get(key);
    if (!ex) { a4Map.set(key, r); continue; }
    a4Map.set(key, { ...ex, as400Ord: ex.as400Ord + r.as400Ord, as400Shpd: ex.as400Shpd + r.as400Shpd });
  }

  const shipMap = new Map<string, ShipLine[]>();
  for (const s of ship) {
    const key = `${s.po}-${s.item}`;
    if (!shipMap.has(key)) shipMap.set(key, []);
    shipMap.get(key)!.push(s);
  }

  return arrow.map((a): ReconRow => {
    const key  = `${a.po}-${a.supplierSku}`;
    const a4   = a4Map.get(key);
    const ships = (shipMap.get(key) ?? []).sort((x, y) => (y.eta ?? '').localeCompare(x.eta ?? ''));
    const latest = ships[0] ?? null;

    const as400Ord  = a4?.as400Ord  ?? 0;
    const as400Shpd = a4?.as400Shpd ?? 0;
    const onWater   = Math.max(0, as400Shpd - a.qtyReceived);

    let status: ReconRow['status'] = 'ok';
    if (!a4)                                              status = 'missing';
    else if (latest?.delivered)                           status = 'delivered';
    else if (onWater > 0 || latest)                       status = 'in_transit';
    else if (as400Shpd === 0 && a.qtyOutstanding > 0)    status = 'not_received';

    const lateVsRequest = !!(a.requestedDate && a4?.eta && a4.eta > a.requestedDate && a.qtyOutstanding > 0);

    return {
      ...a,
      as400Ord, as400Shpd,
      as400OrderDate: a4?.as400OrderDate ?? null,
      as400Eta:      a4?.eta        ?? null,
      shipDate:      a4?.shipDate   ?? null,
      shipToName:    a4?.shipToName    ?? null,
      shipToCity:    a4?.shipToCity    ?? null,
      shipToState:   a4?.shipToState   ?? null,
      shipToPostcode:a4?.shipToPostcode ?? null,
      usSoNumber:    a4?.usSoNumber    ?? null,
      onWater,
      container:    latest?.container ?? null,
      vessel:       latest?.vessel    ?? null,
      containerEta: latest?.eta       ?? null,
      carrier:      latest?.carrier   ?? null,
      status,
      lateVsRequest,
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

type FilterTab = 'all' | 'exceptions' | 'not_received' | 'in_transit' | 'delivered' | 'awaiting';

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

  // AS400 CSV upload
  const handleAs400File = useCallback(async (file: File) => {
    setUploadingA4(true);
    try {
      const text = await file.text();
      const lines = parseAs400Csv(text);
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
    if (tab === 'exceptions')   r = r.filter((x) => x.status === 'missing' || x.lateVsRequest);
    if (tab === 'not_received') r = r.filter((x) => x.status === 'not_received');
    if (tab === 'in_transit')   r = r.filter((x) => x.status === 'in_transit');
    if (tab === 'delivered')    r = r.filter((x) => x.status === 'delivered');
    if (tab === 'awaiting')     r = r.filter((x) => x.as400Ord === 0 && x.status !== 'missing');
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter((x) =>
        x.po.includes(q) ||
        x.arrowStock.toLowerCase().includes(q) ||
        x.supplierSku.toLowerCase().includes(q) ||
        (x.description ?? '').toLowerCase().includes(q) ||
        (x.creditor ?? '').toLowerCase().includes(q) ||
        (creditorName[x.creditor ?? ''] ?? '').toLowerCase().includes(q) ||
        (x.usSoNumber ?? '').toLowerCase().includes(q) ||
        (x.container ?? '').toLowerCase().includes(q) ||
        (x.vessel ?? '').toLowerCase().includes(q) ||
        (x.shipToName ?? '').toLowerCase().includes(q) ||
        (x.shipToCity ?? '').toLowerCase().includes(q),
      );
    }
    return r;
  }, [rows, tab, search]);

  const stats = useMemo(() => ({
    total:      rows.length,
    exceptions: rows.filter((x) => x.status === 'missing' || x.lateVsRequest).length,
    inTransit:  rows.filter((x) => x.status === 'in_transit').length,
    delivered:  rows.filter((x) => x.status === 'delivered').length,
    late:       rows.filter((x) => x.lateVsRequest).length,
  }), [rows]);

  const fmtMeta = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

  const tabs: { id: FilterTab; label: string; count?: number }[] = [
    { id: 'all',          label: 'All',           count: stats.total },
    { id: 'exceptions',   label: 'Exceptions',    count: stats.exceptions },
    { id: 'not_received', label: 'Not received' },
    { id: 'in_transit',   label: 'In transit',    count: stats.inTransit },
    { id: 'delivered',    label: 'Delivered',      count: stats.delivered },
    { id: 'awaiting',     label: 'Awaiting ship' },
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
          { label: 'In Transit',      value: stats.inTransit,   color: 'text-blue-600' },
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
                  'PO','Status','Type','Stock Code','Supplier SKU','Description','Order Date','ETA Arrow',
                  'Ordered','Received','Arrow PO Ref','AS400 ENT','AS400 SHPD','AS400 Order Date','AS400 ETA','US SO#',
                  'Ship To','City','State','Postcode','Addr OK',
                  'On Water','Container','Vessel','Container ETA','Supplier'
                ];
                const escape = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const addrOk = (r: ReconRow) => {
                  if (!r.shipToCity) return '?';
                  const city = r.shipToCity.toLowerCase();
                  return ['dandenong','victoria','melbourne','sydney','brisbane','perth','adelaide'].some(c => city.includes(c)) ? 'AU' : 'Check';
                };
                const csvRows = filtered.map(r => [
                  r.po, r.status, HAYWARD_CREDITORS.has(r.creditor ?? '') ? 'Hayward' : '3rd Party',
                  r.arrowStock, r.supplierSku, r.description ?? '', r.orderDate ?? '', r.requestedDate ?? '',
                  r.qtyOrdered, r.qtyReceived,
                  r.as400Ord > 0 ? r.po : '', r.as400Ord === 0 ? 'missing' : r.as400Ord, r.as400Shpd,
                  r.as400OrderDate ?? '', r.as400Eta ?? '', r.usSoNumber ?? '',
                  r.shipToName ?? '', r.shipToCity ?? '', r.shipToState ?? '', r.shipToPostcode ?? '', addrOk(r),
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
          {/* Actual scrollable table */}
          <div
            id="bottom-scroll"
            className="overflow-x-auto"
            onScroll={(e) => {
              const top = document.getElementById('top-scroll');
              if (top) top.scrollLeft = (e.target as HTMLDivElement).scrollLeft;
              const inner = document.getElementById('top-scroll-inner');
              const tbl = (e.target as HTMLDivElement).querySelector('table');
              if (inner && tbl) inner.style.width = tbl.scrollWidth + 'px';
            }}
            ref={(el) => {
              if (!el) return;
              const inner = document.getElementById('top-scroll-inner');
              const tbl = el.querySelector('table');
              if (inner && tbl) inner.style.width = tbl.scrollWidth + 'px';
            }}
          >
          <table className="w-full text-left text-xs" style={{ minWidth: '2400px', tableLayout: 'auto', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ minWidth: '75px' }}  />
              <col style={{ minWidth: '90px' }}  />
              <col style={{ minWidth: '90px' }}  />{/* Supplier type */}
              <col style={{ minWidth: '130px' }} />
              <col style={{ minWidth: '120px' }} />
              <col style={{ minWidth: '200px' }} />
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
              <col style={{ minWidth: '80px' }}  />
              <col style={{ minWidth: '130px' }} />
              <col style={{ minWidth: '160px' }} />
              <col style={{ minWidth: '110px' }} />
              <col style={{ minWidth: '120px' }} />
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="text-[11px] font-bold uppercase tracking-widest">
                <th colSpan={3} style={{ background: '#334155', color: 'white', padding: '6px 12px', borderRight: '2px solid white', position: 'sticky', left: 0, zIndex: 11 }}>
                  Order
                </th>
                <th colSpan={7} style={{ background: '#059669', color: 'white', padding: '6px 12px', borderRight: '2px solid white', position: 'sticky', left: '255px', zIndex: 11 }}>
                  Arrow AU
                </th>
                <th colSpan={6} style={{ background: '#f59e0b', color: 'white', padding: '6px 12px', borderRight: '2px solid white' }}>
                  AS400 · USA
                </th>
                <th colSpan={5} style={{ background: '#0ea5e9', color: 'white', padding: '6px 12px', borderRight: '2px solid white' }}>
                  Delivery address
                </th>
                <th colSpan={5} style={{ background: '#7c3aed', color: 'white', padding: '6px 12px' }}>
                  CDS-Net · Shipment
                </th>
              </tr>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide">
                <th className="sticky left-0 z-10 bg-slate-800 px-3 py-2.5 whitespace-nowrap text-white">PO</th>
                <th className="sticky bg-slate-700 px-3 py-2.5 whitespace-nowrap text-white" style={{ left: '75px' }}>Status</th>
                <th className="sticky bg-slate-600 px-3 py-2.5 whitespace-nowrap text-white border-r border-slate-500" style={{ left: '165px' }}>Type</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900" style={{ left: '255px' }}>Stock code</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900" style={{ left: '385px' }}>Supplier SKU</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900" style={{ left: '505px' }}>Description</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900" style={{ left: '705px' }}>Order date</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 whitespace-nowrap text-emerald-900" style={{ left: '805px' }}>ETA Arrow</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 text-right whitespace-nowrap text-emerald-900" style={{ left: '905px' }}>Ordered</th>
                <th className="sticky bg-emerald-200 px-3 py-2.5 text-right whitespace-nowrap text-emerald-900 border-r-2 border-emerald-400" style={{ left: '980px' }}>Received</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900">Arrow PO ref</th>
                <th className="bg-amber-100 px-3 py-2.5 text-right whitespace-nowrap text-amber-900">ENT</th>
                <th className="bg-amber-100 px-3 py-2.5 text-right whitespace-nowrap text-amber-900">SHPD</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900">Order date</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900">ETA</th>
                <th className="bg-amber-100 px-3 py-2.5 whitespace-nowrap text-amber-900 border-r-2 border-amber-300">US SO#</th>
                <th className="bg-sky-100 px-3 py-2.5 whitespace-nowrap text-sky-900">Ship to</th>
                <th className="bg-sky-100 px-3 py-2.5 whitespace-nowrap text-sky-900">City</th>
                <th className="bg-sky-100 px-3 py-2.5 whitespace-nowrap text-sky-900">State</th>
                <th className="bg-sky-100 px-3 py-2.5 whitespace-nowrap text-sky-900">Postcode</th>
                <th className="bg-sky-100 px-3 py-2.5 whitespace-nowrap text-sky-900 border-r-2 border-sky-300">Addr OK?</th>
                <th className="bg-violet-100 px-3 py-2.5 text-right whitespace-nowrap text-violet-900">On water</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900">Container</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900">Vessel</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900">Cont. ETA</th>
                <th className="bg-violet-100 px-3 py-2.5 whitespace-nowrap text-violet-900">Supplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={26} className="py-12 text-center text-slate-400">
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
                      <td className="sticky bg-slate-800 px-3 py-2" style={{ left: '75px' }}>
                        {statusBadge(r.status)}
                      </td>
                      <td className="sticky bg-slate-700 px-3 py-2 border-r border-slate-600" style={{ left: '165px' }}>
                        {supplierTypeBadge(r.creditor)}
                      </td>
                      <td className="sticky bg-emerald-50 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-slate-800" style={{ left: '255px' }}>{r.arrowStock}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-slate-700" style={{ left: '385px' }}>{r.supplierSku || '—'}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 text-slate-800" style={{ left: '505px' }} title={r.description ?? ''}>{r.description ?? '—'}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 whitespace-nowrap text-slate-500" style={{ left: '705px' }}>{fmt(r.orderDate)}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 whitespace-nowrap text-slate-700" style={{ left: '805px' }}>
                        {fmt(r.requestedDate)}
                        {r.lateVsRequest && <span className="ml-1 text-red-500" title="Late vs requested date">&#x26A0;</span>}
                      </td>
                      <td className="sticky bg-emerald-50 px-3 py-2 text-right font-bold text-emerald-900" style={{ left: '905px' }}>{r.qtyOrdered}</td>
                      <td className="sticky bg-emerald-50 px-3 py-2 text-right text-slate-600 border-r-2 border-emerald-300" style={{ left: '980px' }}>{r.qtyReceived}</td>
                      <td className="bg-amber-50 px-3 py-2 whitespace-nowrap font-mono text-[11px]">
                        {r.as400Ord === 0
                          ? <span className="text-red-400">—</span>
                          : <span className="text-green-700 font-semibold">&#10003; {r.po}</span>
                        }
                      </td>
                      <td className="bg-amber-50 px-3 py-2 text-right">
                        {r.as400Ord === 0
                          ? <span className="font-semibold text-red-600">missing</span>
                          : <span className="font-semibold text-amber-900">{r.as400Ord}</span>}
                      </td>
                      <td className="bg-amber-50 px-3 py-2 text-right text-amber-800">{r.as400Shpd || '—'}</td>
                      <td className="bg-amber-50 px-3 py-2 whitespace-nowrap text-slate-600">{fmt(r.as400OrderDate)}</td>
                      <td className="bg-amber-50 px-3 py-2 whitespace-nowrap text-slate-600">{fmt(r.as400Eta)}</td>
                      <td className="bg-amber-50 px-3 py-2 font-mono text-[11px] text-slate-500 border-r-2 border-amber-200">{r.usSoNumber ?? '—'}</td>
                      <td className="bg-sky-50 px-3 py-2 text-slate-700" title={r.shipToName ?? ''}>{r.shipToName ?? '—'}</td>
                      <td className="bg-sky-50 px-3 py-2 whitespace-nowrap text-slate-700">{r.shipToCity ?? '—'}</td>
                      <td className="bg-sky-50 px-3 py-2 text-slate-600">{r.shipToState ?? '—'}</td>
                      <td className="bg-sky-50 px-3 py-2 text-slate-600">{r.shipToPostcode ?? '—'}</td>
                      <td className="bg-sky-50 px-3 py-2 border-r-2 border-sky-200">
                        {r.as400Ord === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : addr === 'ok' ? (
                          <span className="font-semibold text-green-600">&#10003; AU</span>
                        ) : addr === 'warn' ? (
                          <span className="font-semibold text-red-600" title={`Unexpected: ${r.shipToCity}, ${r.shipToState}`}>&#x26A0; Check</span>
                        ) : (
                          <span className="text-slate-400">?</span>
                        )}
                      </td>
                      <td className="bg-violet-50 px-3 py-2 text-right">
                        {r.onWater > 0
                          ? <span className="font-bold text-violet-700">{r.onWater}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="bg-violet-50 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-violet-800">{r.container ?? '—'}</td>
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
    </div>
  );
}
