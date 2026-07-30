'use client';

// app/dashboard/warranty/page.tsx
//
// Lists the logged-in customer's warranty tickets (those with a Packing Slip
// Number in Freshdesk) and, for each product on the linked sales order, its
// live stock position: available now, plus what's on order and when it's due.
// Includes a search box that filters by Freshdesk ticket number, packing slip
// number, or SKU code. Data comes from GET /api/warranty-tickets.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  ExternalLink,
  PackageCheck,
  PackageX,
  Truck,
  Loader2,
  Search,
  X,
} from 'lucide-react';

const FRESHDESK_PORTAL = 'hayward-supportdesk.freshdesk.com';

interface Delivery {
  eta: string | null;
  qty: number;
}
interface LineStock {
  available: number;
  backordered: number;
  onOrder: number;
  nextEta: string | null;
  deliveries: Delivery[];
  inStock: boolean;
}
interface Line {
  sku: string;
  description: string | null;
  qtyOrdered: number;
  qtyBackordered: number;
  stock: LineStock;
}
interface WarrantyTicket {
  ticketId: number;
  subject: string;
  status: string;
  packingSlip: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  lines: Line[];
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'Open' || status === 'Pending'
      ? 'bg-wave/10 text-wave'
      : status === 'Resolved'
        ? 'bg-emerald-50 text-emerald-700'
        : 'bg-ink/5 text-ink/50';
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{status}</span>;
}

// Availability chip + (independently) an "on order / ETA" chip whenever there's
// incoming supply, so an in-stock item still shows what's arriving next. If
// there are multiple inbound deliveries, each is listed with its date.
function StockCell({ stock }: { stock: LineStock }) {
  const nextEta = fmtDate(stock.nextEta);
  const deliveries = (stock.deliveries || []).filter((d) => d.qty > 0);
  const showSchedule = deliveries.length > 1;

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {/* availability now */}
      {stock.inStock ? (
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
          <PackageCheck className="h-3.5 w-3.5" />
          {stock.available} in stock
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700">
          <PackageX className="h-3.5 w-3.5" />
          {stock.onOrder > 0 ? 'Out of stock' : 'On backorder'}
        </span>
      )}

      {/* incoming supply — shown regardless of in-stock state */}
      {stock.onOrder > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
          <Truck className="h-3.5 w-3.5" />
          {stock.onOrder} on order{nextEta ? ` · ETA ${nextEta}` : ' · ETA TBC'}
        </span>
      )}

      {/* full inbound schedule when more than one delivery is expected */}
      {showSchedule && (
        <div className="text-right text-[11px] leading-tight text-ink/40">
          {deliveries.map((d, i) => (
            <div key={i}>
              {d.qty} · {fmtDate(d.eta) || 'date TBC'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WarrantyTicketsPage() {
  const [tickets, setTickets] = useState<WarrantyTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetch('/api/warranty-tickets')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setTickets(d.tickets || []))
      .catch(() => setError('Could not load your warranty tickets. Please try again shortly.'))
      .finally(() => setLoading(false));
  }, []);

  // Filter by Freshdesk ticket number, packing slip number, or SKU code.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter(
      (t) =>
        String(t.ticketId).includes(q) ||
        (t.packingSlip || '').toLowerCase().includes(q) ||
        (t.lines || []).some((l) => (l.sku || '').toLowerCase().includes(q))
    );
  }, [tickets, query]);

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
            <ShieldCheck className="h-5 w-5 text-wave" />
            Warranty jobs
          </h1>
          <p className="mt-1 text-sm text-ink/60">
            Your warranty tickets and the live stock position for each product on them.
          </p>
        </div>
        <Link
          href={`https://${FRESHDESK_PORTAL}/support/tickets/new`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink/10 px-3 py-2 text-sm text-ink/70 transition hover:bg-foam"
        >
          New warranty claim
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Search */}
      <div className="mb-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ticket number, packing slip, or SKU…"
            className="w-full rounded-xl border border-ink/10 bg-white py-2.5 pl-10 pr-10 text-sm text-ink shadow-soft outline-none transition focus:border-wave/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink/40 transition hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {!loading && !error && query && (
          <p className="mt-2 text-xs text-ink/50">
            Showing {filtered.length} of {tickets.length} tickets
          </p>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-ink/50">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your warranty jobs…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
      )}

      {!loading && !error && tickets.length === 0 && (
        <div className="rounded-2xl border border-ink/10 bg-white p-8 text-center text-sm text-ink/50 shadow-soft">
          No warranty tickets with a packing slip number were found for your account.
        </div>
      )}

      {!loading && !error && tickets.length > 0 && filtered.length === 0 && (
        <div className="rounded-2xl border border-ink/10 bg-white p-8 text-center text-sm text-ink/50 shadow-soft">
          No warranty tickets match “{query}”.
        </div>
      )}

      <div className="space-y-4">
        {filtered.map((t) => (
          <div key={t.ticketId} className="rounded-2xl border border-ink/10 bg-white shadow-soft">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/5 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{t.subject || `Ticket #${t.ticketId}`}</span>
                  <StatusPill status={t.status} />
                </div>
                <div className="mt-0.5 text-xs text-ink/50">
                  Packing slip <span className="font-medium text-ink/70">{t.packingSlip}</span>
                  {fmtDate(t.createdAt) ? ` · Logged ${fmtDate(t.createdAt)}` : ''}
                </div>
              </div>
              <Link
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-wave hover:underline"
              >
                Ticket #{t.ticketId}
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>

            <div className="divide-y divide-ink/5">
              {t.lines.length === 0 && (
                <div className="px-5 py-3 text-xs text-ink/40">No order lines found for this packing slip.</div>
              )}
              {t.lines.map((l, i) => (
                <div key={`${t.ticketId}-${l.sku}-${i}`} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{l.description || l.sku}</div>
                    <div className="text-xs text-ink/40">
                      {l.sku} · ordered {l.qtyOrdered}
                      {l.qtyBackordered > 0 ? ` · ${l.qtyBackordered} backordered on this job` : ''}
                    </div>
                  </div>
                  <StockCell stock={l.stock} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
