'use client';

// app/dashboard/container-orders/page.tsx
// Direct container orders, staff only: each Hayward US / Wuxi purchase order
// alongside the customer sales order it fills, where it is being delivered,
// and when it lands. Data: /api/container-orders (Redis, written by
// sync-container-orders.js on AZ-Grey + the CDS-Net shipment file already
// uploaded on the Purchasing page).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Container, Ship, Anchor, PackageCheck, Clock, AlertTriangle, Link2, Link2Off,
  ChevronDown, ChevronUp, Search, Download, Loader2, RefreshCw, MapPin, Phone, X,
} from 'lucide-react';
import type {
  ContainerOrder, ContainerOrdersPayload, ContainerSo, ContainerStatus,
} from '@/lib/container-orders';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${SHORT_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

function dateTime(value: string | null | undefined) {
  if (!value) return 'never';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? 'unknown'
    : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' });
}

const AUD = (v: number | null | undefined) =>
  v == null ? '—' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(v);

const qty = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-AU'));

const STATUS: Record<ContainerStatus, { label: string; icon: typeof Ship; className: string; bar: string }> = {
  awaiting_shipment: { label: 'Awaiting shipment', icon: Clock, className: 'bg-amber/10 text-amber', bar: 'bg-amber' },
  in_transit: { label: 'In transit', icon: Ship, className: 'bg-wave/10 text-wave', bar: 'bg-wave' },
  arrived: { label: 'Arrived', icon: Anchor, className: 'bg-splash/10 text-splash', bar: 'bg-splash' },
  completed: { label: 'Completed', icon: PackageCheck, className: 'bg-ink/5 text-ink/50', bar: 'bg-ink/20' },
  cancelled: { label: 'Cancelled', icon: X, className: 'bg-coral/10 text-coral', bar: 'bg-coral' },
};

const SO_STATUS: Record<string, string> = {
  C: 'Completed', A: 'In progress', X: 'Cancelled', B: 'Backordered', H: 'On hold', S: 'Standing', '': 'Draft',
};

const OPEN_STATUSES: ContainerStatus[] = ['awaiting_shipment', 'in_transit', 'arrived'];

type StatusFilter = 'open' | 'all' | ContainerStatus;
type SortKey = 'eta' | 'poDate' | 'customer' | 'po';

function daysFromToday(iso: string | null) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${iso}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: ContainerStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${s.className}`}>
      <Icon className="h-3 w-3" /> {s.label}
    </span>
  );
}

function Tile({ label, value, hint, accent, active, onClick }: {
  label: string; value: number | string; hint?: string; accent: string; active?: boolean; onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-2xl bg-white border px-4 py-3 shadow-soft transition-colors ${
        active ? 'border-wave ring-2 ring-wave/20' : 'border-ink/10 hover:border-ink/20'
      }`}
    >
      <p className="text-[11px] uppercase tracking-wide text-ink/40 font-semibold">{label}</p>
      <p className={`mt-1 font-display text-2xl font-semibold ${accent}`}>{value}</p>
      {hint && <p className="text-xs text-ink/40 mt-0.5">{hint}</p>}
    </button>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-semibold border transition-colors ${
        active ? 'bg-wave text-white border-wave' : 'bg-white text-ink/60 border-ink/10 hover:border-ink/30'
      }`}
    >
      {label}
    </button>
  );
}

function Address({ so }: { so: ContainerSo | null }) {
  if (!so) return <span className="text-ink/30">—</span>;
  const lines = so.address.lines;
  return (
    <div className="text-xs leading-snug">
      {lines.length ? (
        lines.map((l, i) => (
          <div key={i} className={i === 0 ? 'text-ink' : 'text-ink/60'}>{l}</div>
        ))
      ) : (
        <span className="text-ink/30">No address on order</span>
      )}
      {(so.contactName || so.phone) && (
        <div className="mt-1 flex flex-wrap gap-x-2 text-ink/50">
          {so.contactName && <span>{so.contactName}</span>}
          {so.phone && <span className="inline-flex items-center gap-0.5"><Phone className="h-3 w-3" />{so.phone}</span>}
        </div>
      )}
      {so.address.source === 'account' && (
        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-amber">account address — no delivery address on SO</div>
      )}
    </div>
  );
}

// Inline "link this PO to SO ______" control for an unlinked (or wrongly
// linked) PO. The pin lands in Redis straight away; the SO details appear
// once the AZ-Grey sync has run again.
function LinkSo({ po, current, onDone }: { po: string; current: string | null; onDone: (links: Record<string, string>) => void }) {
  const [so, setSo] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/container-orders/link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ po, so }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      onDone(data.links);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function unlink() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/container-orders/link?po=${po}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setSo('');
      onDone(data.links);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      <input
        value={so}
        onChange={(e) => setSo(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="SO #"
        inputMode="numeric"
        className="w-20 rounded-lg border border-ink/10 px-2 py-1 text-xs focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
      />
      <button
        type="submit"
        disabled={busy || so.length !== 6}
        className="inline-flex items-center gap-1 rounded-lg bg-wave px-2 py-1 text-xs font-semibold text-white disabled:opacity-40"
        title="Pin this PO to a sales order"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />} Link
      </button>
      {current && (
        <button type="button" onClick={unlink} disabled={busy} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink/50 hover:text-coral" title="Remove the pinned link">
          <Link2Off className="h-3 w-3" />
        </button>
      )}
      {err && <span className="text-xs text-coral">{err}</span>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function OrderRow({ o, expanded, toggle, links, onLinks }: {
  o: ContainerOrder; expanded: boolean; toggle: () => void;
  links: Record<string, string>; onLinks: (l: Record<string, string>) => void;
}) {
  const s = STATUS[o.status];
  const pinnedTo = links[o.po] ?? null;
  const pinPending = pinnedTo && (!o.so || o.so.orderNo !== pinnedTo);
  const etaIn = daysFromToday(o.eta);
  const isOpen = OPEN_STATUSES.includes(o.status);

  return (
    <>
      <tr className={`border-t border-ink/5 align-top ${expanded ? 'bg-foam/60' : 'hover:bg-foam/40'}`}>
        <td className="pl-0 pr-2 py-3 w-1"><div className={`h-full min-h-[3rem] w-1 rounded-r ${s.bar}`} /></td>

        {/* Customer */}
        <td className="px-2 py-3">
          {o.so ? (
            <>
              <div className="font-semibold text-ink text-sm leading-tight">{o.so.customerName}</div>
              <div className="text-xs text-ink/40 font-mono">{o.so.customerCode}</div>
            </>
          ) : (
            <div className="text-xs text-ink/40 italic">{o.customerPoRef ? `Ref "${o.customerPoRef}"` : 'No customer ref'}</div>
          )}
        </td>

        {/* Sales order */}
        <td className="px-2 py-3">
          {o.so ? (
            <>
              <div className="font-mono text-sm text-ink">SO {o.so.orderNo}</div>
              <div className="text-xs text-ink/50">{shortDate(o.so.orderDate)} · {SO_STATUS[o.so.statusFlag] ?? o.so.statusFlag}</div>
              {o.so.customerOrderNo && <div className="text-xs text-ink/50">Cust PO <span className="font-mono text-ink/70">{o.so.customerOrderNo}</span></div>}
              {o.matchMethod === 'manual' && <div className="text-[10px] uppercase tracking-wide text-wave">pinned</div>}
              {o.ambiguousCandidates > 1 && (
                <div className="text-[10px] uppercase tracking-wide text-amber inline-flex items-center gap-0.5"><AlertTriangle className="h-3 w-3" />{o.ambiguousCandidates} SOs share this ref</div>
              )}
            </>
          ) : (
            <div className="space-y-1">
              <div className="text-xs font-semibold text-amber inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> No SO found</div>
              {pinPending && <div className="text-[11px] text-wave">Pinned to SO {pinnedTo} — shows after next sync</div>}
              <LinkSo po={o.po} current={pinnedTo} onDone={onLinks} />
            </div>
          )}
        </td>

        {/* Purchase order */}
        <td className="px-2 py-3">
          <div className="font-mono text-sm text-ink">PO {o.po}</div>
          <div className="text-xs text-ink/50">{o.supplierName} · {shortDate(o.poDate)}</div>
          <div className="text-xs text-ink/50">{qty(o.poQty)} units{o.poReceived > 0 && <> · {qty(o.poReceived)} rec&apos;d</>}</div>
        </td>

        {/* Containers */}
        <td className="px-2 py-3">
          {o.shipments.length ? (
            <div className="space-y-1">
              {o.shipments.slice(0, 3).map((c) => (
                <div key={c.container} className="text-xs">
                  <span className={`font-mono ${c.delivered ? 'text-ink/50 line-through decoration-ink/30' : 'text-ink'}`}>{c.container}</span>
                  {c.vessel && <span className="text-ink/40"> · {c.vessel}</span>}
                </div>
              ))}
              {o.shipments.length > 3 && <div className="text-[11px] text-ink/40">+{o.shipments.length - 3} more</div>}
            </div>
          ) : (
            <span className="text-xs text-ink/30">Not in shipment file</span>
          )}
        </td>

        {/* Deliver to */}
        <td className="px-2 py-3 min-w-[12rem]"><Address so={o.so} /></td>

        {/* Original ETA */}
        <td className="px-2 py-3 text-sm text-ink/70 whitespace-nowrap">{shortDate(o.poRequestedDate)}</td>

        {/* Current ETA */}
        <td className="px-2 py-3 whitespace-nowrap">
          {o.deliveredDate ? (
            <div className="text-sm text-splash font-semibold">Landed {shortDate(o.deliveredDate)}</div>
          ) : (
            <>
              <div className={`text-sm font-semibold ${o.etaSource === 'container' ? 'text-ink' : 'text-ink/50'}`}>{shortDate(o.eta)}</div>
              {o.etaSource === 'container' && etaIn != null && isOpen && (
                <div className="text-[11px] text-ink/40">{etaIn < 0 ? `${-etaIn}d ago` : etaIn === 0 ? 'today' : `in ${etaIn}d`}</div>
              )}
              {o.etaSource === 'po' && <div className="text-[10px] uppercase tracking-wide text-ink/30">PO date, no container yet</div>}
              {o.daysLate != null && o.daysLate > 0 && (
                <div className="text-[11px] font-semibold text-coral">{o.daysLate}d past original</div>
              )}
            </>
          )}
        </td>

        <td className="px-2 py-3"><StatusBadge status={o.status} /></td>

        <td className="px-2 py-3 text-right">
          <button type="button" onClick={toggle} className="rounded-lg p-1 text-ink/40 hover:bg-ink/5 hover:text-ink" aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-foam/60">
          <td />
          <td colSpan={9} className="px-2 pb-4 pt-0">
            <div className="grid gap-4 lg:grid-cols-[1fr_minmax(16rem,20rem)]">
              {/* Lines */}
              <div className="rounded-xl bg-white border border-ink/10 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-ink/[0.03] text-ink/50 uppercase tracking-wide text-[10px]">
                    <tr>
                      <th className="text-left px-3 py-2">Stock code</th>
                      <th className="text-left px-3 py-2">Supplier SKU</th>
                      <th className="text-left px-3 py-2">Description</th>
                      <th className="text-right px-3 py-2">SO qty</th>
                      <th className="text-right px-3 py-2">PO qty</th>
                      <th className="text-right px-3 py-2">Received</th>
                      <th className="text-right px-3 py-2">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.lines.map((l) => {
                      const mismatch = l.soQty != null && l.poQty != null && l.soQty !== l.poQty;
                      return (
                        <tr key={l.sku} className="border-t border-ink/5">
                          <td className="px-3 py-1.5 font-mono text-ink">{l.sku}</td>
                          <td className="px-3 py-1.5 font-mono text-ink/60">{l.supplierSku ?? '—'}</td>
                          <td className="px-3 py-1.5 text-ink/70">{l.description ?? ''}</td>
                          <td className={`px-3 py-1.5 text-right ${l.soQty == null ? 'text-coral' : mismatch ? 'text-amber font-semibold' : ''}`}>{l.soQty == null ? 'not on SO' : qty(l.soQty)}</td>
                          <td className={`px-3 py-1.5 text-right ${l.poQty == null ? 'text-coral' : mismatch ? 'text-amber font-semibold' : ''}`}>{l.poQty == null ? 'not on PO' : qty(l.poQty)}</td>
                          <td className="px-3 py-1.5 text-right">{qty(l.poReceived)}</td>
                          <td className="px-3 py-1.5 text-right">{qty(l.poOutstanding)}</td>
                        </tr>
                      );
                    })}
                    {o.lines.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-3 text-ink/40">No product lines on this PO.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Side panel */}
              <div className="space-y-3 text-xs">
                <div className="rounded-xl bg-white border border-ink/10 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-ink/40 font-semibold mb-1.5">Containers</p>
                  {o.shipments.length ? o.shipments.map((c) => (
                    <div key={c.container} className="py-1.5 border-t first:border-t-0 border-ink/5">
                      <div className="font-mono text-ink">{c.container}</div>
                      <div className="text-ink/50">{c.vessel ?? 'vessel tba'}{c.destPort ? ` → ${c.destPort}` : ''}</div>
                      <div className="text-ink/50">ETD {shortDate(c.etd)} · ETA {shortDate(c.eta)}{c.delivered ? ` · delivered ${shortDate(c.delivered)}` : ''} · {qty(c.units)} units</div>
                    </div>
                  )) : <p className="text-ink/40">Not yet in the CDS-Net shipment file. Upload the latest file on the <Link href="/dashboard/reconciliation" className="text-wave underline">Purchasing</Link> page.</p>}
                </div>

                <div className="rounded-xl bg-white border border-ink/10 p-3 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-ink/40 font-semibold">Order details</p>
                  {o.so?.description && <p className="text-ink/70">{o.so.description}</p>}
                  {o.so?.netValue != null && <p className="text-ink/70">SO value {AUD(o.so.netValue)}</p>}
                  {o.so?.deliveryDate && <p className="text-ink/70">SO promised {shortDate(o.so.deliveryDate)}</p>}
                  {o.so && o.so.deliveryNotes.length > 0 && (
                    <p className="text-ink/50">SO notes: {o.so.deliveryNotes.join(' / ')}</p>
                  )}
                  {o.poDeliveryNotes.length > 0 && <p className="text-ink/50">PO notes: {o.poDeliveryNotes.join(' / ')}</p>}
                  {o.customerPoRef && <p className="text-ink/50">PO ref field: <span className="font-mono">{o.customerPoRef}</span></p>}
                  <div className="pt-1 border-t border-ink/5">
                    <p className="text-[10px] uppercase tracking-wide text-ink/40 font-semibold mb-1">{o.so ? 'Re-link to a different SO' : 'Link to SO'}</p>
                    <LinkSo po={o.po} current={pinnedTo} onDone={onLinks} />
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ContainerOrdersPage() {
  const [data, setData] = useState<ContainerOrdersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [supplier, setSupplier] = useState<string>('all');
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('eta');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/container-orders', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const orders = data?.orders ?? [];

  const counts = useMemo(() => {
    const open = orders.filter((o) => OPEN_STATUSES.includes(o.status));
    const in30 = open.filter((o) => { const d = daysFromToday(o.eta); return d != null && d >= 0 && d <= 30 && !o.deliveredDate; });
    return {
      open: open.length,
      inTransit: open.filter((o) => o.status === 'in_transit').length,
      awaiting: open.filter((o) => o.status === 'awaiting_shipment').length,
      arriving30: in30.length,
      late: open.filter((o) => o.daysLate != null && o.daysLate > 0).length,
      unlinked: orders.filter((o) => !o.so && o.status !== 'cancelled').length,
      openValue: open.reduce((s, o) => s + (o.so?.netValue ?? 0), 0),
    };
  }, [orders]);

  const suppliers = useMemo(() => [...new Set(orders.map((o) => o.supplierName))].sort(), [orders]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = orders.filter((o) => {
      if (statusFilter === 'open' && !OPEN_STATUSES.includes(o.status)) return false;
      if (statusFilter !== 'open' && statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (supplier !== 'all' && o.supplierName !== supplier) return false;
      if (unlinkedOnly && o.so) return false;
      if (!q) return true;
      const hay = [
        o.po, o.customerPoRef, o.so?.orderNo, o.so?.customerName, o.so?.customerCode, o.so?.customerOrderNo,
        o.so?.description, ...o.shipments.map((c) => c.container), ...o.shipments.map((c) => c.vessel),
        ...(o.so?.address.lines ?? []), ...o.lines.map((l) => l.sku),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    const cmp: Record<SortKey, (a: ContainerOrder, b: ContainerOrder) => number> = {
      eta: (a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999'),
      poDate: (a, b) => (b.poDate ?? '').localeCompare(a.poDate ?? ''),
      customer: (a, b) => (a.so?.customerName ?? 'zzz').localeCompare(b.so?.customerName ?? 'zzz'),
      po: (a, b) => b.po.localeCompare(a.po),
    };
    rows = [...rows].sort(cmp[sortKey]);
    return rows;
  }, [orders, query, statusFilter, supplier, unlinkedOnly, sortKey]);

  const onLinks = useCallback((links: Record<string, string>) => {
    setData((d) => (d ? { ...d, links } : d));
  }, []);

  function toggle(po: string) {
    setExpanded((s) => { const n = new Set(s); n.has(po) ? n.delete(po) : n.add(po); return n; });
  }

  async function exportExcel() {
    if (!data) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows = visible.map((o) => ({
        'Customer': o.so?.customerName ?? '',
        'Customer code': o.so?.customerCode ?? '',
        'SO': o.so?.orderNo ?? '',
        'SO date': o.so?.orderDate ?? '',
        'SO status': o.so ? (SO_STATUS[o.so.statusFlag] ?? o.so.statusFlag) : '',
        'Customer PO': o.so?.customerOrderNo ?? o.customerPoRef ?? '',
        'Arrow PO': o.po,
        'Supplier': o.supplierName,
        'PO date': o.poDate ?? '',
        'PO units': o.poQty,
        'Received': o.poReceived,
        'Container(s)': o.shipments.map((c) => c.container).join(', '),
        'Vessel': o.shipments.map((c) => c.vessel).filter(Boolean).join(', '),
        'Deliver to': o.so?.address.lines.join(', ') ?? '',
        'Contact': o.so?.contactName ?? '',
        'Phone': o.so?.phone ?? '',
        'Original ETA': o.poRequestedDate ?? '',
        'Container ETA': o.etaSource === 'container' ? o.eta : '',
        'Delivered': o.deliveredDate ?? '',
        'Days past original': o.daysLate ?? '',
        'Status': STATUS[o.status].label,
        'SO value': o.so?.netValue ?? '',
        'Notes': [o.so?.description, ...(o.poDeliveryNotes ?? [])].filter(Boolean).join(' / '),
      }));
      const lines = visible.flatMap((o) => o.lines.map((l) => ({
        'Arrow PO': o.po, 'SO': o.so?.orderNo ?? '', 'Customer': o.so?.customerName ?? '',
        'Stock code': l.sku, 'Supplier SKU': l.supplierSku ?? '', 'Description': l.description ?? '',
        'SO qty': l.soQty ?? '', 'PO qty': l.poQty ?? '', 'Received': l.poReceived ?? '', 'Outstanding': l.poOutstanding ?? '',
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Container orders');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lines), 'Lines');
      XLSX.writeFile(wb, `container-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally { setExporting(false); }
  }

  const meta = data?.meta ?? {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-deep flex items-center gap-2">
            <Container className="h-6 w-6 text-wave" /> Container orders
          </h1>
          <p className="text-sm text-ink/50 mt-1">
            Direct container orders — sales order to Wuxi / US purchase order, where it ships to, and when it lands.
          </p>
          <p className="text-xs text-ink/40 mt-1">
            Arrow synced {dateTime(meta.generatedAt)} · shipment file {dateTime(data?.shipmentReceivedAt)}
            {meta.lastError && <span className="text-coral"> · last sync error: {meta.lastError}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={load} className="inline-flex items-center gap-1.5 rounded-xl border border-ink/10 bg-white px-3 py-2 text-sm text-ink/70 hover:border-ink/30">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button type="button" onClick={exportExcel} disabled={exporting || !visible.length} className="inline-flex items-center gap-1.5 rounded-xl bg-deep px-3 py-2 text-sm font-semibold text-white hover:bg-deep/90 disabled:opacity-40">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl bg-white border border-coral/30 px-5 py-4 text-sm text-coral">{error}</div>
      )}

      {/* Tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Open orders" value={counts.open} hint={AUD(counts.openValue) + ' SO value'} accent="text-deep" active={statusFilter === 'open' && !unlinkedOnly} onClick={() => { setStatusFilter('open'); setUnlinkedOnly(false); }} />
        <Tile label="In transit" value={counts.inTransit} accent="text-wave" active={statusFilter === 'in_transit'} onClick={() => { setStatusFilter('in_transit'); setUnlinkedOnly(false); }} />
        <Tile label="Arriving ≤ 30 days" value={counts.arriving30} accent="text-splash" active={false} onClick={() => { setStatusFilter('in_transit'); setSortKey('eta'); setUnlinkedOnly(false); }} />
        <Tile label="Awaiting shipment" value={counts.awaiting} accent="text-amber" active={statusFilter === 'awaiting_shipment'} onClick={() => { setStatusFilter('awaiting_shipment'); setUnlinkedOnly(false); }} />
        <Tile label="Running late" value={counts.late} hint="container ETA past PO date" accent="text-coral" active={false} onClick={() => { setStatusFilter('open'); setSortKey('eta'); setUnlinkedOnly(false); }} />
        <Tile label="PO without SO" value={counts.unlinked} hint="needs a link" accent={counts.unlinked ? 'text-amber' : 'text-ink/40'} active={unlinkedOnly} onClick={() => { setUnlinkedOnly((v) => !v); setStatusFilter('all'); }} />
      </div>

      {/* Filters */}
      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[14rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customer, SO, PO, customer PO, container, SKU, suburb…"
            className="w-full rounded-xl border border-ink/10 pl-9 pr-3 py-2 text-sm focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip label="Open" active={statusFilter === 'open'} onClick={() => setStatusFilter('open')} />
          {(Object.keys(STATUS) as ContainerStatus[]).map((k) => (
            <Chip key={k} label={STATUS[k].label} active={statusFilter === k} onClick={() => setStatusFilter(k)} />
          ))}
          <Chip label="All" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
        </div>
        {suppliers.length > 1 && (
          <div className="flex gap-1.5 border-l border-ink/10 pl-3">
            <Chip label="All suppliers" active={supplier === 'all'} onClick={() => setSupplier('all')} />
            {suppliers.map((s) => <Chip key={s} label={s} active={supplier === s} onClick={() => setSupplier(s)} />)}
          </div>
        )}
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="rounded-xl border border-ink/10 px-3 py-2 text-sm bg-white">
          <option value="eta">Sort: ETA soonest</option>
          <option value="poDate">Sort: newest PO</option>
          <option value="customer">Sort: customer</option>
          <option value="po">Sort: PO number</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-x-auto">
        <table className="w-full min-w-[72rem] text-sm">
          <thead className="bg-ink/[0.03] text-[10px] uppercase tracking-wide text-ink/50">
            <tr>
              <th className="w-1" />
              <th className="text-left px-2 py-2.5">Customer</th>
              <th className="text-left px-2 py-2.5">Sales order</th>
              <th className="text-left px-2 py-2.5">Purchase order</th>
              <th className="text-left px-2 py-2.5">Container</th>
              <th className="text-left px-2 py-2.5"><span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />Deliver to</span></th>
              <th className="text-left px-2 py-2.5">Original ETA</th>
              <th className="text-left px-2 py-2.5">Current ETA</th>
              <th className="text-left px-2 py-2.5">Status</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-ink/40"><Loader2 className="h-5 w-5 animate-spin inline-block mr-2" />Loading container orders…</td></tr>
            )}
            {!loading && data && orders.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-ink/40">
                Nothing synced yet. Run <code className="font-mono text-ink/60">node sync-container-orders.js</code> in <code className="font-mono text-ink/60">C:\Scripts\portal-sync</code> on AZ-Grey.
              </td></tr>
            )}
            {data && orders.length > 0 && visible.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-ink/40">No container orders match these filters.</td></tr>
            )}
            {visible.map((o) => (
              <OrderRow key={o.po} o={o} expanded={expanded.has(o.po)} toggle={() => toggle(o.po)} links={data?.links ?? {}} onLinks={onLinks} />
            ))}
          </tbody>
        </table>
      </div>
      {data && <p className="text-xs text-ink/40 -mt-3">{visible.length} of {orders.length} purchase orders shown.</p>}

      {/* Container-flagged SOs with no PO yet */}
      {data && data.unmatchedSos.length > 0 && (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
          <div className="px-4 py-3 border-b border-ink/5">
            <h2 className="font-display font-semibold text-deep">Container sales orders without a purchase order</h2>
            <p className="text-xs text-ink/40">Open SOs marked CONTAINER / FCL in Arrow that no Wuxi / US PO is linked to yet — pin them from the table above once the PO is raised.</p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-ink/[0.03] text-[10px] uppercase tracking-wide text-ink/50">
              <tr>
                <th className="text-left px-4 py-2">Customer</th>
                <th className="text-left px-2 py-2">SO</th>
                <th className="text-left px-2 py-2">Customer PO</th>
                <th className="text-left px-2 py-2">Ordered</th>
                <th className="text-left px-2 py-2">Promised</th>
                <th className="text-left px-2 py-2">Deliver to</th>
                <th className="text-left px-2 py-2">Description</th>
                <th className="text-right px-4 py-2">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.unmatchedSos.map((s) => (
                <tr key={s.orderNo} className="border-t border-ink/5 align-top">
                  <td className="px-4 py-2"><div className="font-semibold text-ink">{s.customerName}</div><div className="text-xs text-ink/40 font-mono">{s.customerCode}</div></td>
                  <td className="px-2 py-2 font-mono">{s.orderNo}</td>
                  <td className="px-2 py-2 font-mono text-ink/70">{s.customerOrderNo ?? '—'}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{shortDate(s.orderDate)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{shortDate(s.deliveryDate)}</td>
                  <td className="px-2 py-2"><Address so={s} /></td>
                  <td className="px-2 py-2 text-xs text-ink/60">{s.description ?? ''}</td>
                  <td className="px-4 py-2 text-right">{AUD(s.netValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
