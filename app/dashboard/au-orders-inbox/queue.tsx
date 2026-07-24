"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IntakeRecord, IntakeLine } from "@/lib/au-orders-inbox";
import { Copy, Check, ChevronRight, ExternalLink, Lock, Download, X } from "lucide-react";
import * as XLSX from "xlsx";

const fmtMoney = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const POLL_MS = 7_000;
const HEARTBEAT_MS = 5 * 60_000;

/** The list API attaches the matched account's Arrow address to each record.
 *  Not stored on the record itself — the record is a snapshot of the email,
 *  while the account's address can change under it. */
type IntakeRow = IntakeRecord & { accountAddress?: string | null };

type Toast = { text: string; tone: "info" | "warn" } | null;

// YYYY-MM-DD in Melbourne time, so date filters line up with the times shown
// on screen rather than with the browser's UTC day boundary.
const melbDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

// Loose match: case-insensitive, and ignores spaces/dashes/slashes so
// "PO012365-1" is found by typing "012365" or "po 012365 1".
const loose = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function OrderInboxQueue({ meId, meName }: { meId: string; meName: string }) {
  const [orders, setOrders] = useState<IntakeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showKeyed, setShowKeyed] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<Toast>(null);
  // Debtor re-resolve: preview first, apply second. Never a single button.
  const [reResolve, setReResolve] = useState<null | {
    changed: number; unchanged: number; skippedKeyed: number; committed: boolean;
    changes: { id: string; poRef: string | null; before: { code: string | null; name: string | null };
               after: { code: string | null; name: string | null; why?: string } }[];
  }>(null);
  const [reResolveBusy, setReResolveBusy] = useState(false);
  const [queue, setQueue] = useState<{ pending: number; failed: number; failedTail?: string[] } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [view, setView] = useState<"cards" | "quick">("cards");
  // Cards are collapsed by default; an entry here means the user opened that one.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Search / filter bar. All client-side over the already-loaded queue.
  const [fCode, setFCode] = useState("");
  const [fName, setFName] = useState("");
  const [fPo, setFPo] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const showKeyedRef = useRef(showKeyed);
  showKeyedRef.current = showKeyed;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/au-orders-inbox${showKeyedRef.current ? "?includeKeyed=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Couldn't load the queue. Refresh to try again.");
      const data = await res.json();
      setOrders(data.orders);
      setQueue(data.queue ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong loading the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => { load(); }, [showKeyed, load]);

  // Re-run the customer match over records already queued. The debtor is
  // decided at ingest, so a matcher improvement leaves everything already on
  // the page showing the old answer. Extraction is not re-run — only the
  // debtor changes.
  async function runReResolve(commit: boolean) {
    setReResolveBusy(true);
    try {
      const res = await fetch("/api/au-orders-inbox/re-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit }),
      });
      const data = await res.json();
      if (!res.ok) { setToast({ text: data.error ?? "Re-resolve failed.", tone: "warn" }); return; }
      setReResolve(data);
      if (commit) {
        setToast({ text: `${data.changed} debtor${data.changed === 1 ? "" : "s"} updated.`, tone: "info" });
        await load();
      }
    } catch {
      setToast({ text: "Re-resolve failed.", tone: "warn" });
    } finally {
      setReResolveBusy(false);
    }
  }

  // Keep my own claims alive while I'm working them.
  useEffect(() => {
    const t = setInterval(() => {
      orders
        .filter((o) => o.status === "claimed" && o.claimedBy === meId)
        .forEach((o) => fetch(`/api/au-orders-inbox/${o.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "heartbeat" }),
        }).catch(() => {}));
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [orders, meId]);

  const act = useCallback(async (id: string, action: "claim" | "release" | "key") => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/au-orders-inbox/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.reason === "taken") setToast({ text: `Just claimed by ${data.by} — pick another.`, tone: "warn" });
        else if (data.reason === "already_keyed") setToast({ text: "That order was already keyed by someone else.", tone: "warn" });
        else if (data.reason === "closed") setToast({ text: "That order is already done.", tone: "warn" });
        else setToast({ text: "That order is no longer yours to change.", tone: "warn" });
      }
    } catch {
      setToast({ text: "Network hiccup — nothing was changed. Try again.", tone: "warn" });
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      load();
    }
  }, [load]);

  const accept = useCallback(async (id: string, lineIndex: number, sku: string, description: string | null) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/au-orders-inbox/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept-suggestion", lineIndex, sku, description }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.reason === "not_owner") setToast({ text: "Claim the order first, then pick the SKU.", tone: "warn" });
        else if (data.reason === "already_keyed") setToast({ text: "That order is already keyed.", tone: "warn" });
        else setToast({ text: "Couldn't set that SKU — try again.", tone: "warn" });
      }
    } catch {
      setToast({ text: "Network hiccup — SKU not set. Try again.", tone: "warn" });
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      load();
    }
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch {
      setToast({ text: "Couldn't copy — your browser blocked clipboard access.", tone: "warn" });
    }
  }, []);

  const active = orders.filter((o) => o.status !== "keyed");
  const mine = active.filter((o) => o.claimedBy === meId).length;

  const filtersOn = !!(fCode || fName || fPo || fFrom || fTo);
  const clearFilters = () => { setFCode(""); setFName(""); setFPo(""); setFFrom(""); setFTo(""); };

  const visible = orders.filter((o) => {
    if (fCode && !loose(o.debtorCode).includes(loose(fCode))) return false;
    if (fName) {
      const hay = loose([o.debtorName, o.fromName, o.fromEmail].filter(Boolean).join(" "));
      if (!hay.includes(loose(fName))) return false;
    }
    if (fPo && !loose(o.poRef).includes(loose(fPo))) return false;
    if (fFrom || fTo) {
      const d = melbDay(o.receivedAt);
      if (fFrom && d < fFrom) return false;
      if (fTo && d > fTo) return false;
    }
    return true;
  });

  const fieldCls =
    "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
  const labelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">au-orders inbox</h1>
          <p className="text-sm text-slate-500">
            Incoming sales orders to key into Arrow · {active.length} to key{mine ? ` · ${mine} claimed by you` : ""} · {meName}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center overflow-hidden rounded-md border border-slate-300">
            <button
              onClick={() => setView("cards")}
              className={`px-2.5 py-1.5 font-medium ${view === "cards" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              Cards
            </button>
            <button
              onClick={() => setView("quick")}
              className={`px-2.5 py-1.5 font-medium ${view === "quick" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              Quick view
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-slate-600">
            <input type="checkbox" checked={showKeyed} onChange={(e) => setShowKeyed(e.target.checked)} />
            Show keyed
          </label>
          <button
            onClick={() => runReResolve(false)}
            disabled={reResolveBusy}
            title="Re-run the customer match over orders already in the queue. Shows what would change before anything is written."
            className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {reResolveBusy ? "Checking…" : "Re-check debtors"}
          </button>
          <button onClick={load} className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
            Refresh
          </button>
        </div>
      </header>

      {reResolve && (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-sky-900">
                {reResolve.committed ? "Debtors updated" : "Re-check preview — nothing written yet"}
              </p>
              <p className="mt-0.5 text-sky-800">
                {reResolve.changed} would change · {reResolve.unchanged} already correct
                {reResolve.skippedKeyed > 0 && ` · ${reResolve.skippedKeyed} already keyed, left alone`}
              </p>
            </div>
            <button onClick={() => setReResolve(null)} className="p-1 rounded hover:bg-sky-100">
              <X className="h-4 w-4 text-sky-700" />
            </button>
          </div>

          {reResolve.changes.length > 0 && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-sky-200 bg-white">
              <table className="w-full text-xs">
                <tbody>
                  {reResolve.changes.map((c) => (
                    <tr key={c.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-2 py-1.5 font-mono text-slate-500">{c.poRef ?? "—"}</td>
                      <td className="px-2 py-1.5 text-slate-500 line-through">
                        {c.before.code ?? "unresolved"} {c.before.name ?? ""}
                      </td>
                      <td className="px-2 py-1.5 text-slate-400">→</td>
                      <td className="px-2 py-1.5 font-medium text-slate-900">
                        {c.after.code ?? "unresolved"} {c.after.name ?? ""}
                      </td>
                      <td className="px-2 py-1.5 text-slate-400">{c.after.why ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!reResolve.committed && reResolve.changed > 0 && (
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={() => runReResolve(true)}
                disabled={reResolveBusy}
                className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
              >
                {reResolveBusy ? "Applying…" : `Apply ${reResolve.changed} change${reResolve.changed === 1 ? "" : "s"}`}
              </button>
              <span className="text-xs text-sky-800">Check the list above first — this rewrites the queue.</span>
            </div>
          )}
        </div>
      )}

      {queue && (queue.pending > 0 || queue.failed > 0) && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Emails not on this list:</span>{" "}
          {queue.pending > 0 && <>{queue.pending} still waiting to be read</>}
          {queue.pending > 0 && queue.failed > 0 && " · "}
          {queue.failed > 0 && <>{queue.failed} failed extraction</>}
          .{" "}
          {queue.failed > 0 && (
            <span className="text-amber-800">
              Failed ones never became orders — they need to be keyed from the mailbox directly.
            </span>
          )}
        </div>
      )}

      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <label className={labelCls} htmlFor="f-code">Customer code</label>
            <input id="f-code" value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder="200225" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="f-name">Customer name</label>
            <input id="f-name" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Reece Villawood" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="f-po">Customer PO</label>
            <input id="f-po" value={fPo} onChange={(e) => setFPo(e.target.value)} placeholder="PO012365-1" className={fieldCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="f-from">Received from</label>
            <input id="f-from" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} className={fieldCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="f-to">Received to</label>
            <input id="f-to" type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} className={fieldCls} />
          </div>
        </div>
        {filtersOn && (
          <div className="mt-2 flex items-center gap-3 text-xs">
            <span className="text-slate-600">
              Showing <span className="font-semibold text-slate-900">{visible.length}</span> of {orders.length}
            </span>
            <button onClick={clearFilters} className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline">
              <X className="h-3 w-3" /> Clear filters
            </button>
          </div>
        )}
      </div>

      {toast && (
        <div className={`mb-4 rounded-md px-3 py-2 text-sm ${toast.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-sky-50 text-sky-800"}`}>
          {toast.text}
        </div>
      )}
      {error && <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}

      {loading ? (
        <p className="text-sm text-slate-500">Loading the queue…</p>
      ) : orders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
          <p className="font-medium text-slate-700">Nothing in the queue.</p>
          <p className="mt-1 text-sm text-slate-500">Orders from the au-orders mailbox will appear here as they&apos;re processed.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
          <p className="font-medium text-slate-700">No orders match those filters.</p>
          <button onClick={clearFilters} className="mt-2 text-sm font-medium text-sky-700 hover:underline">
            Clear filters
          </button>
        </div>
      ) : view === "quick" ? (
        <QuickView orders={visible} meId={meId} copiedKey={copied} onCopy={copy} onAccept={accept} />
      ) : (
        <div className="space-y-3">
          {visible.map((o) => (
            <OrderRow
              key={o.id}
              order={o}
              meId={meId}
              busy={!!busy[o.id]}
              open={!!expanded[o.id]}
              copiedKey={copied}
              onToggle={() => setExpanded((e) => ({ ...e, [o.id]: !e[o.id] }))}
              onAct={act}
              onAccept={accept}
              onCopy={copy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderRow({
  order, meId, busy, open, copiedKey, onToggle, onAct, onAccept, onCopy,
}: {
  order: IntakeRow;
  meId: string;
  busy: boolean;
  open: boolean;
  copiedKey: string | null;
  onToggle: () => void;
  onAct: (id: string, action: "claim" | "release" | "key") => void;
  onAccept: (id: string, lineIndex: number, sku: string, description: string | null) => void;
  onCopy: (text: string, key: string) => void;
}) {
  const mineClaim = order.status === "claimed" && order.claimedBy === meId;
  const otherClaim = order.status === "claimed" && order.claimedBy !== meId;
  const keyed = order.status === "keyed";
  const orderRev = order.lines.reduce((s, l) => s + (l.qty ?? 0) * (l.claimedPrice ?? 0), 0);
  // Quantity check against Arrow. Matched on debtor + customer PO by the sync;
  // arrowTotalQty is the summed qty of that Arrow order (null = not captured yet).
  const intakeQty = order.lines.reduce((s, l) => s + (l.qty ?? 0), 0);
  const arrowQtyKnown = order.seenInArrow && order.arrowTotalQty != null;
  const qtyMatch = arrowQtyKnown && order.arrowTotalQty === intakeQty;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-white shadow-sm transition-shadow hover:shadow ${
        mineClaim
          ? "border-emerald-200 bg-emerald-50/30"
          : keyed
          ? "border-slate-200 bg-slate-50/50"
          : "border-slate-200"
      }`}
    >
      {/* Header row — click the arrow (or row) to collapse/expand */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50"
      >
        <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-slate-900">{order.debtorName ?? order.fromName ?? order.fromEmail}</span>
            {order.debtorCode ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{order.debtorCode}</span>
            ) : (
              <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">Unresolved</span>
            )}
            {order.poRef && <span className="text-xs text-slate-500">PO {order.poRef}</span>}
            {order.duplicateOf && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">Duplicate</span>}
            {order.extractionConfidence === "low" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Check</span>}
            {order.seenInArrow && (
              qtyMatch ? (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">✓ On Arrow · qty match</span>
              ) : arrowQtyKnown ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">On Arrow · qty differs</span>
              ) : (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">In Arrow</span>
              )
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {order.lines.length} {order.lines.length === 1 ? "line" : "lines"} · <span className="font-medium text-slate-500">{fmtMoney(orderRev)}</span> · {fmtTime(order.receivedAt)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2" onClick={stop}>
          <StatusPill order={order} mine={mineClaim} />
          {order.status === "new" && (
            <button
              disabled={busy}
              onClick={() => onAct(order.id, "claim")}
              className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              Claim
            </button>
          )}
        </div>
      </div>

      {/* Detail — open by default, collapsible via the arrow */}
      {open && (
        <div className="border-t border-slate-100 bg-white px-4 pb-4 pt-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
            {order.debtorCode && (
              <span className="inline-flex items-center gap-1">
                <span className="text-slate-400">Debtor:</span> {order.debtorCode}
                <CopyBtn value={order.debtorCode} k={`${order.id}-deb`} copiedKey={copiedKey} onCopy={onCopy} />
              </span>
            )}
            {order.poRef && (
              <span className="inline-flex items-center gap-1">
                <span className="text-slate-400">PO:</span> {order.poRef}
                <CopyBtn value={order.poRef} k={`${order.id}-po`} copiedKey={copiedKey} onCopy={onCopy} />
              </span>
            )}
            {order.deliverBy && <span><span className="text-slate-400">Deliver by:</span> {order.deliverBy}</span>}
            {order.contact && <span><span className="text-slate-400">Contact:</span> {order.contact}</span>}
            {/* The sender is now the strongest matching signal — the mailbox
                name identifies the branch and the domain identifies the
                company — so showing it lets an agent see the evidence the
                debtor was matched on, and gives them the string to search the
                mailbox with if they need the original email. */}
            {order.fromEmail && (
              <span className="inline-flex items-center gap-1">
                <span className="text-slate-400">From:</span>
                <span className="break-all">{order.fromEmail}</span>
                <CopyBtn value={order.fromEmail} k={`${order.id}-from`} copiedKey={copiedKey} onCopy={onCopy} />
              </span>
            )}
          </div>

          {(order.debtorCandidates ?? []).length > 0 && (
            <div className="mb-3 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              <span className="font-medium">
                {order.debtorCode ? "Debtor not certain — closest accounts:" : "No confident debtor match — closest accounts:"}
              </span>
              <span className="ml-1 inline-flex flex-wrap gap-1.5 align-middle">
                {(order.debtorCandidates ?? []).map((c) => (
                  <span key={c.code} className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 font-mono">
                    {c.code} <span className="font-sans text-slate-600">{c.name}</span>
                    <CopyBtn value={c.code} k={`${order.id}-cand-${c.code}`} copiedKey={copiedKey} onCopy={onCopy} />
                  </span>
                ))}
              </span>
            </div>
          )}
          {/* Two addresses, deliberately side by side: where this order is
              going, and what Arrow holds for the debtor it was matched to.
              Seeing both is how an agent catches a wrong match without opening
              another screen. They often differ legitimately — chain branches
              carry the group's billing address in Arrow, so every Reece branch
              reads Burwood 3125 — which is why the second is labelled as the
              account's address rather than presented as a conflict. */}
          {(order.deliverTo || order.accountAddress) && (
            <div className="mb-3 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
              {order.deliverTo && (
                <p className="min-w-0">
                  <span className="text-slate-400">Ship to:</span>{" "}
                  <span className="break-words">{order.deliverTo}</span>
                </p>
              )}
              {order.accountAddress && (
                <p className="min-w-0">
                  <span className="text-slate-400">Account address:</span>{" "}
                  <span className="break-words text-slate-500">{order.accountAddress}</span>
                </p>
              )}
            </div>
          )}

          {order.seenInArrow && (
            <p className={`mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
              arrowQtyKnown && !qtyMatch ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"
            }`}>
              <Check className="h-4 w-4" />
              {qtyMatch
                ? "Showing on Arrow — quantities match"
                : arrowQtyKnown
                ? `Showing on Arrow — quantities differ (Arrow ${order.arrowTotalQty} / email ${intakeQty})`
                : "Showing on Arrow"}
              {order.arrowOrderNo ? ` as ${order.arrowOrderNo}` : ""}
              {order.arrowEnteredBy ? ` · entered by ${order.arrowEnteredBy}` : ""}
              {order.seenInArrowAt ? ` · ${fmtTime(order.seenInArrowAt)}` : ""}
            </p>
          )}

          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-slate-400">Line items</span>
            <button
              onClick={() => onCopy(order.lines.map((l) => `${l.sku ?? ""}\t${l.qty ?? ""}`).join("\n"), `${order.id}-all`)}
              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {copiedKey === `${order.id}-all` ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              Copy all (SKU + qty)
            </button>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="py-1 font-medium">Qty</th>
                <th className="py-1 font-medium">Customer wrote</th>
                <th className="py-1 font-medium">Matched SKU</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-100 align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      {l.qty ?? "?"}
                      {l.qty != null && <CopyBtn value={String(l.qty)} k={`${order.id}-q${i}`} copiedKey={copiedKey} onCopy={onCopy} />}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-slate-700">{l.raw}</td>
                  <td className="py-1.5">
                    {l.sku ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="font-medium text-slate-900">{l.sku}</span>
                        <CopyBtn value={l.sku} k={`${order.id}-s${i}`} copiedKey={copiedKey} onCopy={onCopy} />
                        {l.qty != null && (
                          <span className="ml-1 inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-xs font-semibold text-sky-700">
                            ×{l.qty}
                            <CopyBtn value={String(l.qty)} k={`${order.id}-sq${i}`} copiedKey={copiedKey} onCopy={onCopy} />
                          </span>
                        )}
                        {l.description && <span className="text-slate-500">— {l.description}</span>}
                      </span>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <span className="font-medium text-rose-600">No match — check</span>
                        {(l.suggestions ?? []).length > 0 && (
                          <>
                            <span className="text-xs text-slate-400">closest:</span>
                            {(l.suggestions ?? []).map((s, si) => (
                              <button
                                key={si}
                                disabled={busy}
                                onClick={(e) => { e.stopPropagation(); onAccept(order.id, i, s.sku, s.description); }}
                                title={mineClaim ? `Use ${s.sku}` : "Claim the order first, then click to use this SKU"}
                                className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                              >
                                {s.sku}{s.description ? ` — ${s.description}` : ""}
                              </button>
                            ))}
                          </>
                        )}
                      </span>
                    )}
                    {l.confidence === "low" && l.sku && <span className="ml-1 text-xs text-amber-700">(low confidence)</span>}
                    {l.pickedBy && l.sku && <span className="ml-1 text-xs font-medium text-emerald-600">✓ picked by {l.pickedBy}</span>}
                    {l.claimedPrice != null && <span className="ml-1 text-xs text-slate-400">cust. quoted ${l.claimedPrice}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {order.notes && <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">{order.notes}</p>}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {order.emailWebUrl ? (
              <a href={order.emailWebUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline">
                Open original email <ExternalLink className="h-3 w-3" />
              </a>
            ) : <span />}

            <div className="flex items-center gap-2">
              {keyed ? (
                <span className="text-xs text-slate-500">Keyed by {order.keyedByName}{order.keyedAt ? ` · ${fmtTime(order.keyedAt)}` : ""}</span>
              ) : otherClaim ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"><Lock className="h-3 w-3" /> {order.claimedByName} is keying this</span>
              ) : mineClaim ? (
                <>
                  <button disabled={busy} onClick={() => onAct(order.id, "release")} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Release</button>
                  <button disabled={busy} onClick={() => onAct(order.id, "key")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Mark as keyed</button>
                </>
              ) : (
                <button disabled={busy} onClick={() => onAct(order.id, "claim")} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">Claim</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyBtn({
  value, k, copiedKey, onCopy,
}: { value: string; k: string; copiedKey: string | null; onCopy: (text: string, key: string) => void }) {
  const done = copiedKey === k;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onCopy(value, k); }}
      aria-label="Copy"
      title="Copy"
      className="inline-flex items-center rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function StatusPill({ order, mine }: { order: IntakeRecord; mine: boolean }) {
  if (order.status === "keyed") return <Pill className="bg-slate-200 text-slate-600">Keyed</Pill>;
  if (mine) return <Pill className="bg-emerald-100 text-emerald-700">Claimed by you</Pill>;
  if (order.status === "claimed") return <Pill className="bg-amber-100 text-amber-800">Being keyed</Pill>;
  return <Pill className="bg-sky-100 text-sky-700">New</Pill>;
}

function Pill({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

/**
 * A horizontal scrollbar ABOVE the content it scrolls, kept in sync with the
 * real one below.
 *
 * The Quick view table is far wider than the screen — Description is the last
 * column and sits well off to the right — so the browser's own scrollbar sits
 * at the BOTTOM of a long table. Reaching it means scrolling to the end of the
 * rows, dragging right, then scrolling back up. This puts a second, linked
 * scrollbar at the top, and pins it just below the dashboard header (which is
 * itself sticky at top-0) so it stays reachable however far down the rows you
 * are, rather than sliding out of view or hiding underneath the header.
 *
 * Implemented as a proxy: an empty div whose width matches the table's real
 * scrollWidth, so the browser gives it a scrollbar of the right proportions.
 * Scroll position is mirrored both ways, guarded by a flag so the two don't
 * drive each other in a loop.
 */
function TopScrollbar({ children }: { children: React.ReactNode }) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setContentWidth(body.scrollWidth);
    measure();
    // Observe the table itself, not just its container: the container's width
    // never changes when columns or rows do, so watching it alone would leave
    // the proxy the wrong length after a filter or a reload.
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [children]);

  const mirror = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  return (
    <>
      {/* Force the scrollbar to be visible and grabbable. Overlay scrollbars
          would otherwise hide it entirely on some platforms, leaving an empty
          strip that looks broken. */}
      <style>{`
        .top-scroll-proxy { scrollbar-width: thin; }
        .top-scroll-proxy::-webkit-scrollbar { height: 12px; }
        .top-scroll-proxy::-webkit-scrollbar-thumb {
          background: #94a3b8; border-radius: 6px;
        }
        .top-scroll-proxy::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 6px; }
      `}</style>
      <div
        ref={topRef}
        onScroll={() => mirror(topRef.current, bodyRef.current)}
        className="top-scroll-proxy sticky top-[3.25rem] z-20 overflow-x-auto overflow-y-hidden bg-white pb-1 shadow-sm"
        aria-hidden="true"
      >
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div ref={bodyRef} onScroll={() => mirror(bodyRef.current, topRef.current)} className="overflow-x-auto">
        {children}
      </div>
    </>
  );
}

function QuickView({
  orders, meId, copiedKey, onCopy, onAccept,
}: {
  orders: IntakeRow[];
  meId: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  onAccept: (id: string, lineIndex: number, sku: string, description: string | null) => void;
}) {
  if (orders.length === 0) return null;

  // Collapse embedded newlines/tabs so a line item stays on ONE row in Excel.
  const clean1 = (s: string) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

  const lineRev = (l: IntakeLine) => (l.qty ?? 0) * (l.claimedPrice ?? 0);
  const custOf = (o: IntakeRecord) => o.debtorName ?? o.fromName ?? o.fromEmail ?? "";
  const statusOf = (o: IntakeRecord) => {
    if (o.seenInArrow) {
      if (o.arrowTotalQty != null) {
        const iq = o.lines.reduce((s, l) => s + (l.qty ?? 0), 0);
        return o.arrowTotalQty === iq ? "On Arrow (qty match)" : "On Arrow (qty differs)";
      }
      return "In Arrow";
    }
    return o.status === "keyed" ? "Keyed" : o.status === "claimed" ? "Claimed" : "New";
  };
  const inArrowOf = (o: IntakeRecord) => (o.seenInArrow ? (o.arrowOrderNo ?? "yes") : "");
  // Qty as entered on the matching Arrow sales order (order-level, so it
  // repeats down the denormalised line rows the same way PO/Debtor do).
  const emailQtyOf = (o: IntakeRecord) => o.lines.reduce((s, l) => s + (l.qty ?? 0), 0);
  const arrowQtyOf = (o: IntakeRecord) => (o.seenInArrow ? o.arrowTotalQty : null);
  const keyedByOf = (o: IntakeRecord) => (o.status === "keyed" ? (o.keyedByName ?? "") : "");

  // One row per line item — denormalised, like an Excel export
  const rows = orders.flatMap((o) => o.lines.map((l, li) => ({ o, l, li })));
  const totalQty = rows.reduce((s, r) => s + (r.l.qty ?? 0), 0);
  const grand = rows.reduce((s, r) => s + lineRev(r.l), 0);
  // Arrow qty is order-level, so sum it once per order, not once per row.
  const arrowTotal = orders.reduce((s, o) => s + (arrowQtyOf(o) ?? 0), 0);

  const th = "border border-slate-300 bg-slate-100 px-2 py-1.5 text-left font-semibold text-slate-700 whitespace-nowrap";
  const td = "border border-slate-300 px-2 py-1 align-top text-slate-700";

  const HEADERS = ["Customer", "Debtor", "Account address", "From", "PO", "Received", "Ship to", "SKU", "Qty", "Arrow qty", "Unit $", "Line $", "Status", "In Arrow", "Keyed by", "Description"];

  // Array-of-arrays used for BOTH the TSV copy and the real .xlsx export.
  const aoa = rows.map((r) => [
    custOf(r.o),
    r.o.debtorCode ?? "",
    r.o.accountAddress ?? "",
    r.o.fromEmail ?? "",
    r.o.poRef ?? "",
    fmtTime(r.o.receivedAt),
    r.o.deliverTo ?? "",
    r.l.sku ?? "",
    r.l.qty ?? "",
    arrowQtyOf(r.o) ?? "",
    r.l.claimedPrice != null ? Number(r.l.claimedPrice) : "",
    Number(lineRev(r.l).toFixed(2)),
    statusOf(r.o),
    inArrowOf(r.o),
    keyedByOf(r.o),
    clean1(r.l.description ?? r.l.raw ?? ""),
  ]);

  function exportXlsx() {
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...aoa]);
    ws["!cols"] = [{ wch: 22 }, { wch: 8 }, { wch: 34 }, { wch: 32 }, { wch: 12 }, { wch: 18 }, { wch: 34 }, { wch: 16 }, { wch: 5 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 50 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "au-orders");
    XLSX.writeFile(wb, `au-orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {orders.length} {orders.length === 1 ? "order" : "orders"} · {rows.length} line items
        </p>
        <button
          onClick={exportXlsx}
          className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
        >
          <Download className="h-4 w-4" /> Export to Excel
        </button>
      </div>

      <TopScrollbar>
        <table className="text-xs" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th className={th}>Customer</th>
              <th className={th}>Debtor</th>
              <th className={th}>PO</th>
              <th className={th}>Received</th>
              <th className={th}>SKU</th>
              <th className={`${th} text-right`}>Qty</th>
              <th className={`${th} text-right`} title="Quantity entered on the matching Arrow sales order">Arrow qty</th>
              <th className={`${th} text-right`}>Unit $</th>
              <th className={`${th} text-right`}>Line $</th>
              <th className={th}>Status</th>
              <th className={th}>In Arrow</th>
              <th className={th}>Keyed by</th>
              <th className={th}>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-sky-50/40">
                <td className={`${td} whitespace-nowrap font-medium text-slate-900`}>{custOf(r.o)}</td>
                <td className={`${td} whitespace-nowrap font-mono`}>
                  {r.o.debtorCode ?? <span className="text-rose-600">—</span>}
                </td>
                <td className={`${td} whitespace-nowrap`}>{r.o.poRef ?? ""}</td>
                <td className={`${td} whitespace-nowrap text-slate-500`}>{fmtTime(r.o.receivedAt)}</td>
                <td className={`${td} whitespace-nowrap font-mono`}>
                  {r.l.sku ? (
                    <span>
                      {r.l.sku}
                      {r.l.pickedBy ? <span className="ml-1 text-[10px] font-sans text-emerald-600">✓</span> : null}
                    </span>
                  ) : (r.l.suggestions ?? []).length > 0 ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <span className="text-rose-600">no match</span>
                      {(r.l.suggestions ?? []).map((s, si) => (
                        <button
                          key={si}
                          onClick={() => onAccept(r.o.id, r.li, s.sku, s.description)}
                          title={r.o.status === "claimed" && r.o.claimedBy === meId ? `Use ${s.sku}` : "Claim the order first"}
                          className="rounded border border-sky-300 bg-sky-50 px-1 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100"
                        >
                          {s.sku}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className="text-rose-600">no match</span>
                  )}
                </td>
                <td className={`${td} text-right tabular-nums`}>{r.l.qty ?? ""}</td>
                <td
                  className={`${td} text-right tabular-nums ${
                    arrowQtyOf(r.o) == null
                      ? "text-slate-400"
                      : arrowQtyOf(r.o) === emailQtyOf(r.o)
                      ? "text-emerald-700"
                      : "font-semibold text-amber-700"
                  }`}
                  title={
                    arrowQtyOf(r.o) == null
                      ? r.o.seenInArrow
                        ? "Order is in Arrow but the qty hasn't been captured by the sync yet"
                        : "Not yet in Arrow"
                      : `Arrow ${arrowQtyOf(r.o)} vs email ${emailQtyOf(r.o)}`
                  }
                >
                  {arrowQtyOf(r.o) ?? "—"}
                </td>
                <td className={`${td} text-right tabular-nums text-slate-500`}>
                  {r.l.claimedPrice != null ? r.l.claimedPrice.toFixed(2) : ""}
                </td>
                <td className={`${td} text-right tabular-nums`}>{lineRev(r.l).toFixed(2)}</td>
                <td className={`${td} whitespace-nowrap`}>{statusOf(r.o)}</td>
                <td className={`${td} whitespace-nowrap font-mono ${r.o.seenInArrow ? "text-emerald-700" : "text-slate-400"}`}>
                  {inArrowOf(r.o) || "—"}
                </td>
                <td className={`${td} whitespace-nowrap`}>{keyedByOf(r.o) || <span className="text-slate-400">—</span>}</td>
                <td className={td}>
                  <span className="block max-w-md truncate" title={clean1(r.l.description ?? r.l.raw ?? "")}>
                    {clean1(r.l.description ?? r.l.raw ?? "")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${td} bg-slate-50 font-semibold`} colSpan={5}>Total</td>
              <td className={`${td} bg-slate-50 text-right font-semibold tabular-nums`}>{totalQty}</td>
              <td className={`${td} bg-slate-50 text-right font-semibold tabular-nums`}>{arrowTotal}</td>
              <td className={`${td} bg-slate-50`}></td>
              <td className={`${td} bg-slate-50 text-right font-bold tabular-nums`}>{grand.toFixed(2)}</td>
              <td className={`${td} bg-slate-50`} colSpan={4}></td>
            </tr>
          </tfoot>
        </table>
      </TopScrollbar>
    </div>
  );
}
