'use client';

// app/dashboard/reconciliation/page.tsx
// Full-width PO reconciliation: Arrow AU vs AS400 (Snowflake upload) vs CDS-Net shipments.
// Includes AS400 delivery address columns for address verification.

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
  item: string;                 // AS400 / supplier SKU
  as400Ord: number;
  as400Shpd: number;
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

type As400Meta = { uploadedAt: string | null; rows: number; filename: string | null };
type ShipMeta = { receivedAt: string | null; rows: number; subject: string | null };
type ArrowMeta = { generatedAt: string | null; rows: number };

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

function statusBadge(s: ReconRow['status']) {
  const map: Record<ReconRow['status'], { label: string; cls: string }> = {
    missing:     { label: 'Missing',     cls: 'bg-red-100 text-red-700' },
    not_received:{ label: 'Not rcvd',   cls: 'bg-amber-100 text-amber-700' },
    in_transit:  { label: 'In transit', cls: 'bg-blue-100 text-blue-700' },
    delivered:   { label: 'Delivered',  cls: 'bg-green-100 text-green-700' },
    ok:          { label: 'OK',         cls: 'bg-slate-100 text-slate-600' },
  };
  const { label, cls } = map[s];
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function addrMatch(row: ReconRow): 'ok' | 'warn' | 'unknown' {
  if (!row.shipToCity) return 'unknown';
  const city = row.shipToCity.toLowerCase();
  const au = ['dandenong','victoria','melbourne','sydney','brisbane','perth','adelaide'];
  return au.some((c) => city.includes(c)) ? 'ok' : 'warn';
}

// ---------------------------------------------------------------------------
// Parse AS400 CSV upload (columns: PO, ITEM, AS400_ORD, AS400_SHPD, ETA,
// SHIP_DATE, SHIP_TO_NAME, SHIP_TO_CITY, SHIP_TO_STATE, SHIP_TO_COUNTRY,
// SHIP_TO_POSTCODE, US_SO_NUMBER)
// ---------------------------------------------------------------------------

function parseAs400Csv(text: string): As400Line[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const hdr = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''));
  const idx = (n: string) => hdr.indexOf(n);
  const c = {
    po: idx('po'), item: idx('item'),
    ord: idx('as400_ord'), shpd: idx('as400_shpd'),
    eta: idx('eta'), shipDate: idx('ship_date'),
    name: idx('ship_to_name'), city: idx('ship_to_city'),
    state: idx('ship_to_state'), country: idx('ship_to_country'),
    postcode: idx('ship_to_postcode'), so: idx('us_so_number'),
  };
  return lines.slice(1).flatMap((line) => {
    const cols = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    const po = cols[c.po];
    if (!po || !/^\d{6}$/.test(po)) return [];
    return [{
      po,
      item: cols[c.item] ?? '',
      as400Ord: Number(cols[c.ord]) || 0,
      as400Shpd: Number(cols[c.shpd]) || 0,
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
// Reconcile Arrow + AS400 + Shipment into unified rows
// ---------------------------------------------------------------------------

function reconcile(arrow: ArrowLine[], as400: As400Line[], ship: ShipLine[]): ReconRow[] {
  // Index AS400 by PO-SKU
  const a4Map = new Map<string, As400Line>();
  for (const r of as400) {
    const key = `${r.po}-${r.item}`;
    const ex = a4Map.get(key);
    if (!ex) { a4Map.set(key, r); continue; }
    // sum quantities if duplicate keys (multiple US SOs for same PO+SKU)
    a4Map.set(key, { ...ex, as400Ord: ex.as400Ord + r.as400Ord, as400Shpd: ex.as400Shpd + r.as400Shpd });
  }

  // Index shipment by PO-item
  const shipMap = new Map<string, ShipLine[]>();
  for (const s of ship) {
    const key = `${s.po}-${s.item}`;
    if (!shipMap.has(key)) shipMap.set(key, []);
    shipMap.get(key)!.push(s);
  }

  return arrow.map((a): ReconRow => {
    const key = `${a.po}-${a.supplierSku}`;
    const a4 = a4Map.get(key);
    const ships = shipMap.get(key) ?? [];
    const latestShip = ships.sort((x, y) =>
      (y.eta ?? '').localeCompare(x.eta ?? ''),
    )[0] ?? null;

    const as400Ord  = a4?.as400Ord  ?? 0;
    const as400Shpd = a4?.as400Shpd ?? 0;
    const onWater   = Math.max(0, as400Shpd - a.qtyReceived);

    let status: ReconRow['status'] = 'ok';
    if (!a4) status = 'missing';
    else if (latestShip?.delivered) status = 'delivered';
    else if (onWater > 0 || latestShip) status = 'in_transit';
    else if (as400Shpd === 0 && a.qtyOutstanding > 0) status = 'not_received';

    const lateVsRequest = !!(
      a.requestedDate && a4?.eta && a4.eta > a.requestedDate && a.qtyOutstanding > 0
    );

    return {
      ...a,
      as400Ord,
      as400Shpd,
      as400Eta: a4?.eta ?? null,
      shipDate: a4?.shipDate ?? null,
      shipToName: a4?.shipToName ?? null,
      shipToCity: a4?.shipToCity ?? null,
      shipToState: a4?.shipToState ?? null,
      shipToPostcode: a4?.shipToPostcode ?? null,
      usSoNumber: a4?.usSoNumber ?? null,
      onWater,
      container: latestShip?.container ?? null,
      vessel: latestShip?.vessel ?? null,
      containerEta: latestShip?.eta ?? null,
      carrier: latestShip?.carrier ?? null,
      status,
      lateVsRequest,
    };
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'exceptions' | 'not_received' | 'in_transit' | 'delivered' | 'awaiting';

export default function ReconciliationPage() {
  const [arrowLines, setArrowLines]   = useState<ArrowLine[]>([]);
  const [as400Lines, setAs400Lines]   = useState<As400Line[]>([]);
  const [shipLines,  setShipLines]    = useState<ShipLine[]>([]);
  const [as400Meta,  setAs400Meta]    = useState<As400Meta>({ uploadedAt: null, rows: 0, filename: null });
  const [shipMeta,   setShipMeta]     = useState<ShipMeta>({ receivedAt: null, rows: 0, subject: null });
  const [arrowMeta,  setArrowMeta]    = useState<ArrowMeta>({ generatedAt: null, rows: 0 });
  const [loading,    setLoading]      = useState(true);
  const [tab,        setTab]          = useState<FilterTab>('all');
  const [search,     setSearch]       = useState('');
  const [uploading,  setUploading]    = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Fetch Arrow + shipment data from portal API
  useEffect(() => {
    Promise.all([
      fetch('/api/recon/arrow').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recon/shipment').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recon/as400').then((r) => r.json()).catch(() => ({})),
    ]).then(([arrow, ship, a400]) => {
      setArrowLines(arrow.lines ?? []);
      setArrowMeta({ generatedAt: arrow.generatedAt ?? null, rows: arrow.lines?.length ?? 0 });
      setShipLines(ship.lines ?? []);
      setShipMeta({ receivedAt: ship.receivedAt ?? null, rows: ship.lines?.length ?? 0, subject: ship.subject ?? null });
      setAs400Lines(a400.lines ?? []);
      setAs400Meta({ uploadedAt: a400.uploadedAt ?? null, rows: a400.lines?.length ?? 0, filename: a400.filename ?? null });
    }).finally(() => setLoading(false));
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
        (x.usSoNumber ?? '').toLowerCase().includes(q),
      );
    }
    return r;
  }, [rows, tab, search]);

  const stats = useMemo(() => ({
    total:       rows.length,
    exceptions:  rows.filter((x) => x.status === 'missing' || x.lateVsRequest).length,
    inTransit:   rows.filter((x) => x.status === 'in_transit').length,
    delivered:   rows.filter((x) => x.status === 'delivered').length,
    late:        rows.filter((x) => x.lateVsRequest).length,
  }), [rows]);

  // Handle AS400 CSV file upload
  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const text = await file.text();
      const lines = parseAs400Csv(text);
      if (!lines.length) { alert('No valid AU PO rows found in this file. Check the column headers match the Snowflake query output.'); return; }

      const res = await fetch('/api/recon/as400-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines, filename: file.name, uploadedAt: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAs400Lines(lines);
      setAs400Meta({ uploadedAt: new Date().toISOString(), rows: lines.length, filename: file.name });
    } catch (e: any) {
      alert('Upload failed: ' + e.message);
    } finally {
      setUploading(false);
    }
  }, []);

  const tabs: { id: FilterTab; label: string; count?: number }[] = [
    { id: 'all',          label: 'All',           count: stats.total },
    { id: 'exceptions',   label: 'Exceptions',    count: stats.exceptions },
    { id: 'not_received', label: 'Not received' },
    { id: 'in_transit',   label: 'In transit',    count: stats.inTransit },
    { id: 'delivered',    label: 'Delivered',      count: stats.delivered },
    { id: 'awaiting',     label: 'Awaiting ship' },
  ];

  const shipMetaDate = shipMeta.receivedAt
    ? new Date(shipMeta.receivedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;
  const arrowMetaDate = arrowMeta.generatedAt
    ? new Date(arrowMeta.generatedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="flex min-h-0 w-full flex-col px-4 py-6">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <span className="text-wave">⚓</span> Order Reconciliation &amp; ETA
          </h1>
          <p className="text-sm text-slate-500">Arrow POs vs AS400 supplier entry vs CDS-Net shipment portal · Australia &amp; New Zealand</p>
        </div>
        <div className="flex gap-2 text-xs text-slate-400">
          {arrowMetaDate && <span>Arrow: {arrowMetaDate}</span>}
          {shipMetaDate  && <span>· Shipments: {shipMetaDate}</span>}
        </div>
      </div>

      {/* ── AS400 upload banner ── */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">
            AS400 data{as400Meta.rows > 0 ? ` · ${as400Meta.rows.toLocaleString()} lines · uploaded ${as400Meta.uploadedAt ? new Date(as400Meta.uploadedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}` : ' · not uploaded'}
          </span>
          <span className="text-xs text-slate-400">manual until the Snowflake service account is live</span>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Run the AS400 query in Snowsight, download the results, and drop the file here. CSV or XLSX both work.
          Rows are re-aggregated to PO + SKU on upload, so it doesn&apos;t matter whether you ran the aggregated or the raw version.
          This replaces the previous upload entirely.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-2 rounded-lg bg-wave px-4 py-2 text-sm font-medium text-white hover:bg-deep disabled:opacity-60"
        >
          {uploading ? 'Uploading…' : '↑ Choose file'}
        </button>
      </div>

      {/* ── KPI cards ── */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: 'PO Lines',       value: stats.total,      color: 'text-ink' },
          { label: 'Exceptions',     value: stats.exceptions,  color: 'text-amber-600' },
          { label: 'In Transit',     value: stats.inTransit,   color: 'text-blue-600' },
          { label: 'Delivered',      value: stats.delivered,   color: 'text-green-700' },
          { label: 'Late vs request',value: stats.late,        color: 'text-red-600' },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-slate-100 bg-white p-4">
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
            <p className="text-xs text-slate-500">{k.label}</p>
          </div>
        ))}
      </div>

      {/* ── Filter row ── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search PO, SKU, supplier…"
          className="min-w-[220px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-wave"
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
        <div className="w-full overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[1600px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {/* Arrow columns */}
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-3 whitespace-nowrap">Stock code</th>
                <th className="px-3 py-3 whitespace-nowrap">Supplier SKU</th>
                <th className="px-3 py-3 whitespace-nowrap">Description</th>
                <th className="px-3 py-3 whitespace-nowrap">PO</th>
                <th className="px-3 py-3 whitespace-nowrap">Order date</th>
                <th className="px-3 py-3 whitespace-nowrap">ETA Arrow</th>
                <th className="px-3 py-3 text-right whitespace-nowrap">ORD</th>
                <th className="px-3 py-3 text-right whitespace-nowrap">RCVD</th>
                {/* AS400 columns */}
                <th className="border-l border-slate-200 px-3 py-3 text-right whitespace-nowrap">AS400 ENT</th>
                <th className="px-3 py-3 text-right whitespace-nowrap">AS400 SHPD</th>
                <th className="px-3 py-3 whitespace-nowrap">AS400 ETA</th>
                <th className="px-3 py-3 whitespace-nowrap">US SO#</th>
                {/* Delivery address verification */}
                <th className="border-l border-blue-100 bg-blue-50 px-3 py-3 whitespace-nowrap">Ship to</th>
                <th className="bg-blue-50 px-3 py-3 whitespace-nowrap">City</th>
                <th className="bg-blue-50 px-3 py-3 whitespace-nowrap">State</th>
                <th className="bg-blue-50 px-3 py-3 whitespace-nowrap">Postcode</th>
                <th className="bg-blue-50 px-3 py-3 whitespace-nowrap">Addr OK?</th>
                {/* Shipment columns */}
                <th className="border-l border-slate-200 px-3 py-3 text-right whitespace-nowrap">On water</th>
                <th className="px-3 py-3 whitespace-nowrap">Container</th>
                <th className="px-3 py-3 whitespace-nowrap">Vessel</th>
                <th className="px-3 py-3 whitespace-nowrap">Container ETA</th>
                <th className="px-3 py-3 whitespace-nowrap">Supplier</th>
                <th className="px-3 py-3 whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={23} className="py-12 text-center text-slate-400">No rows match the current filter.</td>
                </tr>
              ) : (
                filtered.map((r, i) => {
                  const addr = addrMatch(r);
                  return (
                    <tr
                      key={`${r.po}-${r.arrowStock}-${i}`}
                      className={`hover:bg-slate-50 ${r.lateVsRequest ? 'bg-red-50/40' : ''}`}
                    >
                      {/* Arrow */}
                      <td className="sticky left-0 z-10 bg-white px-3 py-2.5 font-mono text-[11px] group-hover:bg-slate-50 whitespace-nowrap">
                        {r.arrowStock}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap">{r.supplierSku || '—'}</td>
                      <td className="max-w-[200px] truncate px-3 py-2.5 text-slate-700" title={r.description ?? ''}>
                        {r.description ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <Link href={`/dashboard/reconciliation?po=${r.po}`} className="font-semibold text-wave hover:underline">
                          {r.po}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">{fmt(r.orderDate)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {fmt(r.requestedDate)}
                        {r.lateVsRequest && <span className="ml-1 text-red-500" title="Late vs requested date">⚠</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold">{r.qtyOrdered}</td>
                      <td className="px-3 py-2.5 text-right text-slate-500">{r.qtyReceived}</td>
                      {/* AS400 */}
                      <td className="border-l border-slate-100 px-3 py-2.5 text-right">
                        {r.as400Ord === 0
                          ? <span className="font-semibold text-red-600">missing</span>
                          : r.as400Ord}
                      </td>
                      <td className="px-3 py-2.5 text-right">{r.as400Shpd || '—'}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">{fmt(r.as400Eta)}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500">{r.usSoNumber ?? '—'}</td>
                      {/* Delivery address verification */}
                      <td className="border-l border-blue-100 bg-blue-50/30 px-3 py-2.5 max-w-[140px] truncate" title={r.shipToName ?? ''}>
                        {r.shipToName ?? '—'}
                      </td>
                      <td className="bg-blue-50/30 px-3 py-2.5 whitespace-nowrap">{r.shipToCity ?? '—'}</td>
                      <td className="bg-blue-50/30 px-3 py-2.5">{r.shipToState ?? '—'}</td>
                      <td className="bg-blue-50/30 px-3 py-2.5">{r.shipToPostcode ?? '—'}</td>
                      <td className="bg-blue-50/30 px-3 py-2.5">
                        {r.as400Ord === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : addr === 'ok' ? (
                          <span className="font-semibold text-green-600">✓ AU</span>
                        ) : addr === 'warn' ? (
                          <span className="font-semibold text-red-600" title={`Unexpected address: ${r.shipToCity}, ${r.shipToState}`}>⚠ Check</span>
                        ) : (
                          <span className="text-slate-400">?</span>
                        )}
                      </td>
                      {/* Shipment */}
                      <td className="border-l border-slate-100 px-3 py-2.5 text-right">
                        {r.onWater > 0
                          ? <span className="font-semibold text-blue-600">{r.onWater}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap">{r.container ?? '—'}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.vessel ?? '—'}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{fmt(r.containerEta)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">
                        {creditorName[r.creditor ?? ''] ?? r.creditor ?? '—'}
                      </td>
                      <td className="px-3 py-2.5">{statusBadge(r.status)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-slate-400">
        {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} lines shown
      </p>
    </div>
  );
}
