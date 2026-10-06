'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Trash2,
  Loader2,
  Printer,
  FileText,
  TrendingUp,
  ShoppingCart,
  CheckCircle2,
  AlertTriangle,
  History,
  X,
  RotateCcw,
  PackageCheck,
  Clock,
} from 'lucide-react';
import { ProductCombobox } from '@/components/ProductCombobox';
import { useSelectedCustomer } from '@/components/SelectedCustomerContext';
import { AccountSelect } from '@/components/AccountSelect';
import { PORTAL_ORDERS_ENABLED } from '@/lib/features';

interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  supplierStock?: string | null;
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }> | null;
  incoming?: { onOrderQty: number; nextEta: string | null } | null;
}

/** What's shown under each line: free stock now, and when a shortfall lands. */
interface Availability {
  free: number | null; // null = no stock record for this SKU
  shortfall: number; // units on this line not covered by free stock
  eta: Date | null; // next inbound supply + 6 days, only when there's a shortfall
}

// Backorder ETA rule (agreed Sep 2026): next container ETA for the SKU plus
// 6 days for unpack and put-away.
const ETA_BUFFER_DAYS = 6;

// Draft quote survives refresh and navigation. Only SKU/name/qty are kept -
// prices are always refetched, so a stored draft can never carry a stale price.
const DRAFT_KEY = 'hayward-quote-draft-v1';

interface PriceTier {
  qty: number;
  price: number | null;
}

interface QuoteLine {
  sku: string;
  name: string;
  qty: number;
  listPrice: number | null;
  tiers: PriceTier[]; // sorted ascending by qty, qty:1 baseline included
  loading: boolean;
  error: string | null;
}

/** One of the Arrow accounts this login is allowed to order against. */
interface AccountOption {
  code: string;
  name: string;
  street?: string | null;
  suburb?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
}

/** A previously submitted portal order, as shown back to the customer. */
interface MyOrder {
  lines?: { sku: string; description: string | null; qty: number }[];
  id: string;
  ref: string;
  poRef: string;
  debtorName: string | null;
  submittedAt: number;
  lineCount: number;
  subTotal: number | null;
  statusLabel: string;
  statusDetail: string | null;
}

function formatMoney(value: number | null) {
  if (value == null) return '-';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One-line postal address from a customer profile, for prefilling delivery. */
function profileAddress(a: AccountOption | undefined): string {
  if (!a) return '';
  return [a.street, a.suburb, a.city, a.state, a.postcode]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function availabilityFor(entry: StockEntry | undefined, qty: number): Availability {
  if (!entry?.byLocation) return { free: null, shortfall: 0, eta: null };
  const free = Math.max(
    0,
    Object.values(entry.byLocation).reduce((sum, l) => sum + ((l?.onHand ?? 0) - (l?.allocated ?? 0)), 0)
  );
  const shortfall = Math.max(0, qty - free);
  let eta: Date | null = null;
  if (shortfall > 0 && entry.incoming?.nextEta) {
    const d = new Date(entry.incoming.nextEta);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + ETA_BUFFER_DAYS);
      eta = d;
    }
  }
  return { free, shortfall, eta };
}

function formatEta(d: Date) {
  return d.toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short' });
}

// Arrow's SPRTRAN thresholds are UPPER bounds:
// qty=3, disc=70% means "qty 1–3 gets 70% off".
// So we find the LOWEST threshold >= qty to get the applicable tier.
function resolvePrice(tiers: PriceTier[], qty: number): number | null {
  const sorted = [...tiers].sort((a, b) => a.qty - b.qty);
  const tier = sorted.find((t) => qty <= t.qty);
  if (tier) return tier.price;
  // qty exceeds all thresholds — use last tier
  return sorted.length > 0 ? sorted[sorted.length - 1].price : null;
}

// Label for a tier given its index in the sorted array.
// e.g. [{qty:3}, {qty:11}, {qty:1000}] →  "1–3", "4–11", "12+"
function tierLabel(sorted: PriceTier[], index: number): string {
  const lower = index === 0 ? 1 : sorted[index - 1].qty + 1;
  const isLast = index === sorted.length - 1;
  if (isLast) return `${lower}+`;
  return `${lower}–${sorted[index].qty}`;
}

interface TierSuggestion {
  extraUnits: number;
  newQty: number;
  newUnitPrice: number;
  savingsPerUnit: number;
  newLineTotal: number;
}

// Finds the next cheaper tier and how many units to add to reach it.
function getNextTierSuggestion(tiers: PriceTier[], qty: number, currentUnitPrice: number | null): TierSuggestion | null {
  if (currentUnitPrice == null) return null;
  const sorted = [...tiers].sort((a, b) => a.qty - b.qty);
  const currentIndex = sorted.findIndex((t) => qty <= t.qty);
  // If we're at the last tier or beyond all tiers, no suggestion
  if (currentIndex === -1 || currentIndex === sorted.length - 1) return null;
  const nextTier = sorted[currentIndex + 1];
  if (nextTier.price == null || nextTier.price >= currentUnitPrice) return null;
  // Next tier starts one unit above the current tier's upper bound
  const nextLowerBound = sorted[currentIndex].qty + 1;
  const extraUnits = nextLowerBound - qty;
  return {
    extraUnits,
    newQty: nextLowerBound,
    newUnitPrice: nextTier.price,
    savingsPerUnit: currentUnitPrice - nextTier.price,
    newLineTotal: nextTier.price * nextLowerBound,
  };
}

export default function PricingPage() {
  const [allStock, setAllStock] = useState<StockEntry[]>([]);
  const [stockLoading, setStockLoading] = useState(true);
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const { selectedCustomer } = useSelectedCustomer();

  // --- order submission state ---------------------------------------------
  const [orderOpen, setOrderOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [debtorCode, setDebtorCode] = useState('');
  const [poRef, setPoRef] = useState('');
  const [requiredBy, setRequiredBy] = useState('');
  const [deliverTo, setDeliverTo] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ ref: string; lineCount: number; subTotal: number } | null>(null);
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Per-group opt-out (lib/page-visibility.ts, e.g. Reece). Starts false so an
  // opted-out group never sees the order button flash up before the check
  // lands; the server also refuses their submits regardless.
  const [orderingAllowed, setOrderingAllowed] = useState(false);
  const orderingOn = PORTAL_ORDERS_ENABLED && orderingAllowed;

  // Always-current view of `lines` so the re-price effect below reads the
  // latest list (incl. a just-added line) rather than a render-time snapshot.
  const linesRef = useRef<QuoteLine[]>([]);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  // Per-SKU request counter. Switching customer re-prices every line; if the
  // earlier customer's response lands after the new one, it must be dropped,
  // otherwise the page shows one customer's price under another's name.
  const reqSeq = useRef<Record<string, number>>({});

  // --- draft persistence ---------------------------------------------------
  const draftRestored = useRef(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      const saved = raw ? (JSON.parse(raw) as { sku: string; name: string; qty: number }[]) : [];
      if (Array.isArray(saved) && saved.length > 0) {
        addLines(saved.filter((l) => l && typeof l.sku === 'string'));
      }
    } catch {
      /* a corrupt draft is just discarded */
    }
    draftRestored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Don't overwrite the saved draft with the empty initial state before the
    // restore above has run.
    if (!draftRestored.current) return;
    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify(lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty })))
      );
    } catch {
      /* private mode / quota - the draft is a convenience, never block on it */
    }
  }, [lines]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stock')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setAllStock(data.results ?? []);
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The accounts this login may raise an order against. This is the same list
  // the submit endpoint validates against, so anything offered here is
  // guaranteed to be accepted.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/customers?scope=mine')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list: AccountOption[] = data.customers ?? [];
        setAccounts(list);
        // One account means there's nothing to choose - don't make them choose.
        if (list.length === 1) setDebtorCode(list[0].code);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMyOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/my-orders', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setMyOrders(data.orders ?? []);
      setOrderingAllowed(data.orderingEnabled === true);
    } catch {
      /* the receipt list is a nicety - never block ordering on it */
    }
  }, []);

  useEffect(() => {
    loadMyOrders();
  }, [loadMyOrders]);

  // Staff viewing a specific customer: default the order to that account.
  useEffect(() => {
    if (selectedCustomer?.code) setDebtorCode(selectedCustomer.code);
  }, [selectedCustomer?.code]);

  // Prefill the delivery address from the chosen account, but only while the
  // customer hasn't typed their own - silently overwriting a hand-typed site
  // address when they switch account would be worse than leaving it blank.
  const deliverToTouched = useRef(false);
  useEffect(() => {
    if (deliverToTouched.current) return;
    const addr = profileAddress(accounts.find((a) => a.code === debtorCode));
    if (addr) setDeliverTo(addr);
  }, [debtorCode, accounts]);

  // Re-price every line already on the quote whenever the selected
  // customer changes (picked from the header, not a page-local control) -
  // prices shown before the switch are for a different customer and
  // would otherwise look right while being wrong.
  useEffect(() => {
    const current = linesRef.current;
    if (current.length === 0) return;
    setLines((prev) => prev.map((l) => ({ ...l, loading: true, error: null })));
    current.forEach((l) => refetchLine(l.sku, l.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.code]);

  function pricingUrl(sku: string, qty: number) {
    const params = new URLSearchParams({ sku, qty: String(qty) });
    if (selectedCustomer) params.set('customerCode', selectedCustomer.code);
    return `/api/pricing?${params.toString()}`;
  }

  async function refetchLine(sku: string, name: string) {
    const seq = (reqSeq.current[sku] = (reqSeq.current[sku] ?? 0) + 1);
    try {
      const res = await fetch(pricingUrl(sku, 1));
      const data = await res.json();
      if (reqSeq.current[sku] !== seq) return; // superseded by a newer request
      setLines((prev) =>
        prev.map((l) =>
          l.sku !== sku
            ? l
            : !res.ok
              ? { ...l, loading: false, error: data.error ?? 'No price found' }
              : {
                  ...l,
                  loading: false,
                  listPrice: data.listPrice,
                  tiers:
                    ((data.breaks ?? []) as PriceTier[]).length > 0
                      ? [...((data.breaks ?? []) as PriceTier[])].sort((a, b) => a.qty - b.qty)
                      : [{ qty: 1, price: data.price }],
                }
        )
      );
    } catch {
      if (reqSeq.current[sku] !== seq) return;
      setLines((prev) =>
        prev.map((l) => (l.sku !== sku ? l : { ...l, loading: false, error: 'Could not reach pricing' }))
      );
    }
  }

  /**
   * Add several lines at once (draft restore, reorder). A SKU already on the
   * quote has its qty increased rather than being added twice - the submit
   * endpoint rejects duplicate SKUs.
   */
  function addLines(items: { sku: string; name?: string | null; qty?: number }[]) {
    const current = new Map(linesRef.current.map((l) => [l.sku, l]));
    const fresh: QuoteLine[] = [];
    const bumped = new Map<string, number>();
    for (const it of items) {
      const sku = it.sku.trim().toUpperCase();
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      if (current.has(sku)) {
        bumped.set(sku, (bumped.get(sku) ?? 0) + qty);
      } else if (!fresh.some((f) => f.sku === sku)) {
        fresh.push({
          sku,
          name: it.name || sku,
          qty,
          listPrice: null,
          tiers: [],
          loading: true,
          error: null,
        });
      }
    }
    const next = [
      ...linesRef.current.map((l) =>
        bumped.has(l.sku) ? { ...l, qty: l.qty + (bumped.get(l.sku) ?? 0) } : l
      ),
      ...fresh,
    ];
    // Update the ref immediately so a second add in the same tick (double
    // click, restore + reorder) sees these lines and can't create a duplicate.
    linesRef.current = next;
    setSubmitted(null);
    setLines(next);
    fresh.forEach((f) => refetchLine(f.sku, f.name));
  }

  function addToQuote(item: StockEntry) {
    addLines([{ sku: item.sku, name: item.name, qty: 1 }]);
  }

  function reorder(o: MyOrder) {
    if (!o.lines || o.lines.length === 0) return;
    addLines(o.lines.map((l) => ({ sku: l.sku, name: l.description, qty: l.qty })));
    setHistoryOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearQuote() {
    setLines([]);
    setOrderOpen(false);
  }

  function updateQty(sku: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.sku === sku ? { ...l, qty: Math.max(1, qty) } : l)));
  }

  function removeLine(sku: string) {
    setLines((prev) => prev.filter((l) => l.sku !== sku));
  }

  const grandTotal = lines.reduce((sum, l) => {
    const price = resolvePrice(l.tiers, l.qty);
    return sum + (price ?? 0) * l.qty;
  }, 0);

  const addedSkus = new Set<string>(lines.map((l) => l.sku));
  const stockBySku = new Map<string, StockEntry>(allStock.map((e) => [e.sku, e]));
  const backorderLines = lines.filter((l) => availabilityFor(stockBySku.get(l.sku), l.qty).shortfall > 0);

  // A line that never priced can't be ordered - that would be sending Hayward
  // an order line with no agreed price on it.
  const unpricedLines = lines.filter((l) => l.error || resolvePrice(l.tiers, l.qty) == null);
  const canSubmit =
    lines.length > 0 &&
    unpricedLines.length === 0 &&
    !lines.some((l) => l.loading) &&
    debtorCode !== '' &&
    poRef.trim() !== '' &&
    agreed &&
    !submitting;

  async function submitOrder(confirmDuplicate = false) {
    setSubmitting(true);
    setSubmitError(null);
    setDuplicate(null);
    try {
      const res = await fetch('/api/orders/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          debtorCode,
          poRef: poRef.trim(),
          requiredBy: requiredBy || null,
          deliverTo: deliverTo.trim() || null,
          contact: contact.trim() || null,
          phone: phone.trim() || null,
          notes: notes.trim() || null,
          confirmDuplicate,
          // The server reprices every line; this is only what we displayed, so
          // an agent can see it if the two ever disagree.
          lines: lines.map((l) => ({ sku: l.sku, qty: l.qty, unitPrice: resolvePrice(l.tiers, l.qty) })),
        }),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === 'duplicate') {
        setDuplicate(data.message ?? 'This PO has already been submitted for this account.');
        return;
      }
      if (!res.ok) {
        setSubmitError(data.error ?? 'We could not submit this order. Please try again.');
        return;
      }

      setSubmitted({ ref: data.ref, lineCount: data.lineCount, subTotal: data.subTotal });
      setLines([]);
      setOrderOpen(false);
      setPoRef('');
      setRequiredBy('');
      setNotes('');
      setAgreed(false);
      loadMyOrders();
    } catch {
      setSubmitError('We could not reach the server. Your order has not been submitted.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">
            {orderingOn ? 'Quote & order' : 'Quote builder'}
          </h1>
          <p className="text-ink/50 mt-1">
            {orderingOn
              ? 'Add products, see your price and availability per line, then place your order.'
              : 'Add products, set quantities, get your discounted price per line.'}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          {myOrders.length > 0 && (
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2"
            >
              <History className="h-4 w-4" /> My orders
            </button>
          )}
          {lines.length > 0 && (
            <button
              onClick={clearQuote}
              className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-coral/30 hover:text-coral flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" /> Clear
            </button>
          )}
          {lines.length > 0 && (
            <button
              onClick={() => window.print()}
              className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2"
            >
              <Printer className="h-4 w-4" /> Print quote
            </button>
          )}
          {orderingOn && lines.length > 0 && !orderOpen && (
            <button
              onClick={() => {
                setOrderOpen(true);
                setSubmitted(null);
              }}
              className="rounded-xl bg-wave text-white px-4 py-2.5 text-sm font-semibold shadow-soft hover:bg-deep flex items-center gap-2"
            >
              <ShoppingCart className="h-4 w-4" /> Place order
            </button>
          )}
        </div>
      </div>

      {submitted && (
        <div className="rounded-2xl bg-splash/5 border border-splash/30 px-5 py-4 flex items-start gap-3 print:hidden">
          <CheckCircle2 className="h-5 w-5 text-splash flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-deep">Order received - your reference is {submitted.ref}</p>
            <p className="text-ink/60 mt-1">
              {submitted.lineCount} line{submitted.lineCount === 1 ? '' : 's'}, {formatMoney(submitted.subTotal)} ex
              GST. You can follow its progress under My orders. Prices and availability are confirmed on our order
              acknowledgement.
            </p>
          </div>
        </div>
      )}

      {historyOpen && myOrders.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-soft print:hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-ink/40">
                <th className="px-5 py-3.5 font-medium">Reference</th>
                <th className="px-5 py-3.5 font-medium">Your PO</th>
                <th className="px-5 py-3.5 font-medium">Account</th>
                <th className="px-5 py-3.5 font-medium">Submitted</th>
                <th className="px-5 py-3.5 font-medium text-right">Total</th>
                <th className="px-5 py-3.5 font-medium">Status</th>
                <th className="px-5 py-3.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {myOrders.map((o) => (
                <tr key={o.id} className="border-b border-ink/5 last:border-0">
                  <td className="px-5 py-3 font-mono text-xs text-deep font-semibold">{o.ref}</td>
                  <td className="px-5 py-3">{o.poRef}</td>
                  <td className="px-5 py-3 text-ink/60">{o.debtorName ?? '-'}</td>
                  <td className="px-5 py-3 text-ink/60">{formatDate(o.submittedAt)}</td>
                  <td className="px-5 py-3 text-right">{formatMoney(o.subTotal)}</td>
                  <td className="px-5 py-3">
                    <span className="rounded-full bg-foam text-deep px-2.5 py-1 text-xs font-medium">
                      {o.statusLabel}
                    </span>
                    {o.statusDetail && <span className="text-xs text-ink/40 ml-2">{o.statusDetail}</span>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {o.lines && o.lines.length > 0 && (
                      <button
                        onClick={() => reorder(o)}
                        className="rounded-lg border border-ink/10 bg-white px-3 py-1.5 text-xs font-medium hover:border-wave/30 hover:text-wave inline-flex items-center gap-1.5"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Reorder
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedCustomer && (
        <div className="rounded-xl bg-wave/5 border border-wave/20 px-4 py-2.5 text-sm text-deep">
          Showing pricing for <span className="font-semibold">{selectedCustomer.name}</span> - change this from the
          picker in the top bar.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Find by SKU</label>
          <ProductCombobox
            mode="sku"
            options={allStock}
            excludeSkus={addedSkus}
            disabled={stockLoading}
            onSelect={addToQuote}
            placeholder={stockLoading ? 'Loading products…' : 'Type a SKU or supplier code'}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Find by description</label>
          <ProductCombobox
            mode="description"
            options={allStock}
            excludeSkus={addedSkus}
            disabled={stockLoading}
            onSelect={addToQuote}
            placeholder={stockLoading ? 'Loading products…' : 'Type a product description'}
          />
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <FileText className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">
            {orderingOn
              ? 'Search above and add products to start your order.'
              : 'Search above and add products to start a quote.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-ink/40">
                <th className="px-5 py-3.5 font-medium">Product</th>
                <th className="px-5 py-3.5 font-medium text-right">Qty</th>
                <th className="px-5 py-3.5 font-medium text-right">List price</th>
                <th className="px-5 py-3.5 font-medium text-right">Unit price</th>
                <th className="px-5 py-3.5 font-medium text-right">Line total(ex GST)</th>
                <th className="px-5 py-3.5 font-medium print:hidden"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const unitPrice = resolvePrice(l.tiers, l.qty);
                const discountPercent =
                  l.listPrice && unitPrice != null
                    ? Math.round((1 - unitPrice / l.listPrice) * 1000) / 10
                    : null;
                const suggestion = getNextTierSuggestion(l.tiers, l.qty, unitPrice);
                const sortedTiers = [...l.tiers].sort((a, b) => a.qty - b.qty);
                const avail = availabilityFor(stockBySku.get(l.sku), l.qty);

                return (
                  <Fragment key={l.sku}>
                    <tr className="border-b border-ink/5">
                      <td className="px-5 py-3.5">
                        <p className="font-medium text-ink">{l.name}</p>
                        <p className="text-xs text-ink/40 font-mono">{l.sku}</p>
                        {avail.free != null && (
                          <p
                            className={`mt-1 text-xs font-medium flex items-center gap-1 print:hidden ${
                              avail.shortfall === 0 ? 'text-splash' : 'text-amber'
                            }`}
                          >
                            {avail.shortfall === 0 ? (
                              <>
                                <PackageCheck className="h-3.5 w-3.5" /> In stock
                              </>
                            ) : (
                              <>
                                <Clock className="h-3.5 w-3.5" />
                                {avail.free > 0 ? `${avail.free} available, ` : ''}
                                {avail.shortfall} on backorder
                                {avail.eta ? ` - ETA ${formatEta(avail.eta)}` : ' - ETA to be confirmed'}
                              </>
                            )}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <input
                          type="number"
                          min="1"
                          value={l.qty}
                          onChange={(e) => updateQty(l.sku, Number(e.target.value) || 1)}
                          className="w-20 rounded-lg border border-ink/10 px-2 py-1 text-right text-sm focus:border-wave outline-none print:border-none"
                        />
                      </td>
                      <td className="px-5 py-3.5 text-right text-ink/50">
                        {l.loading || l.error ? '-' : formatMoney(l.listPrice)}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {l.loading ? (
                          <Loader2 className="h-4 w-4 animate-spin inline text-ink/30" />
                        ) : l.error ? (
                          <span className="text-xs text-amber">{l.error}</span>
                        ) : (
                          <div>
                            <div>{formatMoney(unitPrice)}</div>
                            {discountPercent ? (
                              <div className="text-xs font-semibold text-sunset">-{discountPercent}% off list</div>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right font-semibold text-deep">
                        {!l.loading && !l.error ? formatMoney((unitPrice ?? 0) * l.qty) : '-'}
                      </td>
                      <td className="px-5 py-3.5 text-right print:hidden">
                        <button onClick={() => removeLine(l.sku)} className="p-1.5 rounded-full hover:bg-coral/10">
                          <Trash2 className="h-4 w-4 text-ink/30 hover:text-coral" />
                        </button>
                      </td>
                    </tr>
                    {!l.loading && !l.error && sortedTiers.length > 0 && (
                      <tr className="border-b border-ink/5 last:border-0 print:hidden">
                        <td colSpan={6} className="px-5 pb-3.5 pt-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-ink/40">Quantity breaks:</span>
                            {sortedTiers.map((t, idx) => {
                              const lowerBound = idx === 0 ? 1 : sortedTiers[idx - 1].qty + 1;
                              const isActive = l.qty >= lowerBound && l.qty <= t.qty;
                              const label = tierLabel(sortedTiers, idx);
                              return (
                                <span
                                  key={t.qty}
                                  className={`text-xs rounded-full px-2.5 py-1 font-medium ${
                                    isActive ? 'bg-wave text-white' : 'bg-foam text-ink/50'
                                  }`}
                                >
                                  {label}: {formatMoney(t.price)}
                                </span>
                              );
                            })}
                            {suggestion && (
                              <button
                                onClick={() => updateQty(l.sku, suggestion.newQty)}
                                className="flex items-center gap-1.5 text-xs rounded-full bg-splash/10 text-splash px-2.5 py-1 font-medium hover:bg-splash/20 transition-colors"
                              >
                                <TrendingUp className="h-3 w-3" />
                                Add {suggestion.extraUnits} more ({suggestion.newQty} total) to drop to{' '}
                                {formatMoney(suggestion.newUnitPrice)}/unit - save {formatMoney(suggestion.savingsPerUnit)}
                                /unit
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-foam">
                <td className="px-5 py-4 font-semibold text-deep" colSpan={4}>
                  Total (ex GST)
                </td>
                <td className="px-5 py-4 text-right font-display text-lg text-deep font-bold" colSpan={2}>
                  {formatMoney(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ---------------- Convert to order ---------------- */}
      {orderingOn && orderOpen && lines.length > 0 && (
        <div className="rounded-2xl border border-wave/30 bg-white shadow-soft print:hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-ink/10">
            <h2 className="font-display text-xl text-deep font-bold">Place your order</h2>
            <button onClick={() => setOrderOpen(false)} className="p-1.5 rounded-full hover:bg-ink/5">
              <X className="h-4 w-4 text-ink/40" />
            </button>
          </div>

          <div className="px-5 py-5 space-y-4">
            {unpricedLines.length > 0 && (
              <div className="rounded-xl bg-amber/10 border border-amber/30 px-4 py-3 text-sm text-ink/70 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber flex-shrink-0 mt-0.5" />
                <span>
                  {unpricedLines.map((l) => l.sku).join(', ')} {unpricedLines.length === 1 ? 'has' : 'have'} no
                  price yet, so this order can&apos;t be sent. Remove {unpricedLines.length === 1 ? 'it' : 'them'}{' '}
                  and ask us to quote separately.
                </span>
              </div>
            )}

            {backorderLines.length > 0 && unpricedLines.length === 0 && (
              <div className="rounded-xl bg-foam border border-wave/20 px-4 py-3 text-sm text-ink/70 flex items-start gap-2">
                <Clock className="h-4 w-4 text-wave flex-shrink-0 mt-0.5" />
                <span>
                  {backorderLines.length === 1 ? 'One line is' : `${backorderLines.length} lines are`} partly or
                  fully on backorder. Available stock ships now and the balance follows when it lands, unless you
                  tell us otherwise in the notes.
                </span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">
                  Deliver to account <span className="text-coral">*</span>
                </label>
                {/* One searchable control. The separate filter box and native
                    <select> were two states that could disagree, and a native
                    select can't do the prefix matching that makes Arrow's
                    truncated names findable. */}
                <AccountSelect
                  accounts={accounts}
                  value={debtorCode}
                  onChange={setDebtorCode}
                />
                {accounts.length === 0 && (
                  <p className="text-xs text-amber mt-1.5">
                    No accounts are linked to this login yet - please contact Hayward before ordering.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">
                  Your purchase order number <span className="text-coral">*</span>
                  <span className="ml-1 font-normal text-ink/30">(max 15 characters)</span>
                </label>
                <input
                  value={poRef}
                  onChange={(e) => setPoRef(e.target.value)}
                  maxLength={15}
                  placeholder="e.g. PO-45219"
                  className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Required by (optional)</label>
                <input
                  type="date"
                  value={requiredBy}
                  onChange={(e) => setRequiredBy(e.target.value)}
                  className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Delivery address</label>
                <textarea
                  value={deliverTo}
                  onChange={(e) => {
                    deliverToTouched.current = true;
                    setDeliverTo(e.target.value);
                  }}
                  rows={2}
                  maxLength={120}
                  className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Site contact (optional)</label>
                <input
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  maxLength={30}
                  placeholder="Contact name"
                  className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">Contact phone (optional)</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={30}
                  placeholder="Phone number"
                  className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink/40 mb-1.5 ml-1">
                  Notes (optional) <span className="font-normal text-ink/30">(max 150 characters)</span>
                </label>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={150}
                  placeholder="Anything we should know"
                  className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
                />
              </div>
            </div>

            <div className="rounded-xl bg-foam px-4 py-3 flex items-center justify-between text-sm">
              <span className="text-ink/60">
                {lines.length} line{lines.length === 1 ? '' : 's'}
              </span>
              <span className="font-display text-lg text-deep font-bold">
                {formatMoney(grandTotal)}{' '}
                <span className="text-xs font-body font-normal text-ink/40">ex GST</span>
              </span>
            </div>

            <label className="flex items-start gap-2.5 text-sm text-ink/60">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-ink/20"
              />
              <span>
                I&apos;m authorised to place this order for the selected account. Prices and availability are
                confirmed on Hayward&apos;s order acknowledgement.
              </span>
            </label>

            {submitError && (
              <div className="rounded-xl bg-coral/10 border border-coral/30 px-4 py-3 text-sm text-ink/70 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-coral flex-shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            {duplicate && (
              <div className="rounded-xl bg-amber/10 border border-amber/30 px-4 py-3 text-sm text-ink/70 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber flex-shrink-0 mt-0.5" />
                <div>
                  <p>{duplicate}</p>
                  <p className="mt-1 text-ink/50">
                    If this is a genuinely separate order, use a different PO number. Only send it anyway if
                    you&apos;re sure.
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={() => submitOrder(true)}
                      disabled={submitting}
                      className="rounded-lg bg-amber text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      Send anyway
                    </button>
                    <button
                      onClick={() => setDuplicate(null)}
                      className="rounded-lg border border-ink/10 bg-white px-3 py-1.5 text-xs font-medium"
                    >
                      Let me change the PO
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setOrderOpen(false)}
                className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium"
              >
                Keep editing
              </button>
              <button
                onClick={() => submitOrder(false)}
                disabled={!canSubmit}
                className="rounded-xl bg-wave text-white px-5 py-2.5 text-sm font-semibold shadow-soft hover:bg-deep disabled:opacity-40 disabled:hover:bg-wave flex items-center gap-2"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
                Place order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
