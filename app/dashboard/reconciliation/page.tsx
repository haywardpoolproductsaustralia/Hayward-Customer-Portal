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
  stockCategory: string;  // STOCK_CATEGORY from STKMAST (PR, WD, B2, etc)
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
  if (!row.shipToCountry) return 'unknown';
  const cc = row.shipToCountry.toUpperCase();
  if (cc === 'AU') {
    const port = (row.shipToCity ?? '').toLowerCase();
    return AUNZ_PORTS.has(port) ? 'ok' : 'warn';
  }
  if (cc === 'NZ') return 'ok';
  return 'warn';
}

const ARROW_API = '/api/reconciliation';

type UploadBannerProps = {
  label: string;
  sublabel: string;
  hint: string;
  meta: string;
  uploading: boolean;
  accept: string;
  onFile: (f: File) => void;
};

function UploadBanner({ label, sublabel, hint, meta, uploading, accept, onFile }: UploadBannerProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div
      className={`p-4 rounded border-2 border-dashed cursor-pointer transition-all ${
        drag ? 'bg-blue-50 border-blue-400' : 'bg-slate-50 border-slate-200 hover:border-slate-300'
      }`}
      onDragEnter={() => setDrag(true)}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) onFile(f);
      }}
      onClick={() => ref.current?.click()}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
        className="hidden"
      />
      <div className="font-semibold text-slate-900">{label}</div>
      <div className="text-xs text-slate-600 mt-0.5">{sublabel}</div>
      <div className="text-xs text-slate-500 mt-2 italic">{hint}</div>
      <div className="text-xs text-slate-400 mt-2">
        {uploading ? '↻ uploading...' : meta}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReconciliationPage() {
  // ─ Fetch and state ─
  const [rows, setRows] = useState<ReconRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterText, setFilterText] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('');  // ADD: category filter state

  const [as400Meta, setAs400Meta] = useState<As400Meta>({ uploadedAt: null, rows: 0, filename: null });
  const [shipMeta, setShipMeta] = useState<ShipMeta>({ receivedAt: null, rows: 0, filename: null });
  const [arrowMeta, setArrowMeta] = useState<ArrowMeta>({ generatedAt: null, rows: 0 });

  const [uploadingA4, setUploadingA4] = useState(false);
  const [uploadingShip, setUploadingShip] = useState(false);

  // ─ Load initial data ─
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(ARROW_API);
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        setRows(data.rows ?? []);
        setAs400Meta(data.as400Meta ?? { uploadedAt: null, rows: 0, filename: null });
        setShipMeta(data.shipMeta ?? { receivedAt: null, rows: 0, filename: null });
        setArrowMeta(data.arrowMeta ?? { generatedAt: null, rows: 0 });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ─ Filter rows ─
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterText) {
        const term = filterText.toLowerCase();
        const fields = [r.po, r.arrowStock, r.supplierSku, r.description ?? '', r.shipToName ?? ''];
        if (!fields.some(f => f.toLowerCase().includes(term))) return false;
      }
      // ADD: Filter by category
      if (filterCategory && r.stockCategory !== filterCategory) {
        return false;
      }
      return true;
    });
  }, [rows, filterText, filterCategory]);  // ADD filterCategory to dependencies

  // ─ Upload handlers ─
  const handleAs400File = useCallback(async (f: File) => {
    setUploadingA4(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const resp = await fetch('/api/reconciliation/upload-as400', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setAs400Meta(data.meta);
      setRows((prev) => data.rows ?? prev);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingA4(false);
    }
  }, []);

  const handleShipFile = useCallback(async (f: File) => {
    setUploadingShip(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const resp = await fetch('/api/reconciliation/upload-as400/shipment', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setShipMeta(data.meta);
      setRows((prev) => data.rows ?? prev);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingShip(false);
    }
  }, []);

  // ─ Sync scroll ─
  const topRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = SCROLLBAR_STYLE;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleScroll = (src: HTMLElement | null, dst: HTMLElement | null) => {
    if (!src || !dst) return;
    dst.scrollLeft = src.scrollLeft;
  };

  // ─ Render ─
  const fmtMeta = (d: string | null) => d ? new Date(d).toLocaleDateString('en-AU') : null;

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded bg-red-50 border border-red-200 p-4 text-red-700">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 overflow-hidden">
      <div>
        <h1 className="text-2xl font-bold">Order Reconciliation & ETA</h1>
        <p className="text-xs text-slate-500 mt-1">
          Arrow (open POs) · AS400 (supplier entry) · CDS-Net (shipments)
        </p>
      </div>

      {/* ── Filters ── */}
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Filter by PO, stock code, SKU, description..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
        />
      </div>

      {/* ── Category Filter Dropdown ── */}
      <div className="flex items-center gap-3 bg-slate-50 p-3 rounded border border-slate-200">
        <label htmlFor="cat-filter" className="font-semibold text-slate-700 text-sm">
          Stock Category:
        </label>
        <select
          id="cat-filter"
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-3 py-1.5 border border-slate-300 rounded font-mono text-sm"
        >
          <option value="">All Categories ({rows.length})</option>
          {Array.from(new Set(rows.map(r => r.stockCategory).filter(Boolean)))
            .sort()
            .map(cat => {
              const count = rows.filter(r => r.stockCategory === cat).length;
              return (
                <option key={cat} value={cat}>
                  {cat} ({count})
                </option>
              );
            })}
        </select>
        {filterCategory && (
          <span className="text-xs text-slate-600">
            Showing {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} lines
          </span>
        )}
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="py-12 text-center text-slate-400">Loading reconciliation data...</div>
      ) : (
        <>
          <div className="overflow-hidden rounded border border-slate-200 flex flex-col" style={{ maxHeight: 'calc(100vh - 300px)' }}>
            {/* ── Top scroll sync div ── */}
            <div
              ref={topRef}
              id="top-scroll"
              className="overflow-x-auto overflow-y-hidden flex-shrink-0 border-b border-slate-100"
              onScroll={() => handleScroll(topRef.current, botRef.current)}
              style={{ visibility: 'hidden', height: 0 }}
            />

            {/* ── Actual scrollable table ── */}
            <div
              ref={botRef}
              id="bottom-scroll"
              className="overflow-x-auto overflow-y-auto flex-1"
              onScroll={() => handleScroll(botRef.current, topRef.current)}
            >
          <table className="border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide">
                <th className="sticky left-0 z-20 bg-slate-800 px-3 py-2.5 whitespace-nowrap text-white">
                  Arrow
                </th>
                <th className="sticky bg-slate-700 px-3 py-2.5 whitespace-nowrap text-white" style={{ left: '75px' }}>
                  —
                </th>
                <th className="sticky bg-slate-600 px-3 py-2.5 whitespace-nowrap text-white border-r border-slate-500" style={{ left: '165px' }}>
                  —
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

      {/* ── Upload banners — bottom of page ── */}
      <div className="grid gap-3 lg:grid-cols-2 pt-4 border-t border-slate-100">
        <UploadBanner
          label="AS400 data"
          sublabel="manual until Snowflake service account is live"
          hint="Run the AS400 query in Snowsight, download as CSV, and drop it here. Columns: PO, ITEM, AS400_ORD, AS400_SHPD, ETA, SHIP_DATE, SHIP_TO_NAME, SHIP_TO_CITY, SHIP_TO_STATE, SHIP_TO_COUNTRY, SHIP_TO_POSTCODE, US_SO_NUMBER."
          meta={as400Meta.rows > 0 ? `${as400Meta.rows.toLocaleString()} lines · ${fmtMeta(as400Meta.uploadedAt) ?? ''} · ${as400Meta.filename ?? ''}` : 'not uploaded'}
          uploading={uploadingA4}
          accept=".csv"
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
