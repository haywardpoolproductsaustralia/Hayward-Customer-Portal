"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { IntakeRecord, IntakeLine } from "@/lib/au-orders-inbox";
import { Copy, Check, ExternalLink, Lock } from "lucide-react";

const fmtMoney = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const POLL_MS = 7_000;
const HEARTBEAT_MS = 5 * 60_000;

type Toast = { text: string; tone: "info" | "warn" } | null;

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function OrderInboxQueue({ meId, meName }: { meId: string; meName: string }) {
  const [orders, setOrders] = useState<IntakeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showKeyed, setShowKeyed] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<Toast>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [view, setView] = useState<"cards" | "quick">("cards");
  const showKeyedRef = useRef(showKeyed);
  showKeyedRef.current = showKeyed;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/au-orders-inbox${showKeyedRef.current ? "?includeKeyed=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Couldn't load the queue. Refresh to try again.");
      const data = await res.json();
      setOrders(data.orders);
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
          <button onClick={load} className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
            Refresh
          </button>
        </div>
      </header>

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
      ) : view === "quick" ? (
        <QuickView orders={orders} meId={meId} copiedKey={copied} onCopy={copy} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
          {orders.map((o) => (
            <OrderRow
              key={o.id}
              order={o}
              meId={meId}
              busy={!!busy[o.id]}
              copiedKey={copied}
              onAct={act}
              onCopy={copy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderRow({
  order, meId, busy, copiedKey, onAct, onCopy,
}: {
  order: IntakeRecord;
  meId: string;
  busy: boolean;
  copiedKey: string | null;
  onAct: (id: string, action: "claim" | "release" | "key") => void;
  onCopy: (text: string, key: string) => void;
}) {
  const mineClaim = order.status === "claimed" && order.claimedBy === meId;
  const otherClaim = order.status === "claimed" && order.claimedBy !== meId;
  const keyed = order.status === "keyed";
  const orderRev = order.lines.reduce((s, l) => s + (l.qty ?? 0) * (l.claimedPrice ?? 0), 0);

  return (
    <div className={mineClaim ? "bg-emerald-50/30" : keyed ? "bg-slate-50/60" : ""}>
      {/* Header row — always visible, no toggle */}
      <div className="flex items-center gap-3 px-3 py-2.5">
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
            {order.seenInArrow && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">In Arrow</span>}
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {order.lines.length} {order.lines.length === 1 ? "line" : "lines"} · <span className="font-medium text-slate-500">{fmtMoney(orderRev)}</span> · {fmtTime(order.receivedAt)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
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

      {/* Detail — always open */}
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
          </div>
          {order.deliverTo && <p className="mb-3 text-sm text-slate-600"><span className="text-slate-400">To:</span> {order.deliverTo}</p>}

          {order.seenInArrow && (
            <p className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-sm text-emerald-700">
              <Check className="h-4 w-4" />
              In Arrow{order.arrowOrderNo ? ` as ${order.arrowOrderNo}` : ""}
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
                      <span className="font-medium text-rose-600">No match — check</span>
                    )}
                    {l.confidence === "low" && l.sku && <span className="ml-1 text-xs text-amber-700">(low confidence)</span>}
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

function QuickView({
  orders, meId, copiedKey, onCopy,
}: {
  orders: IntakeRecord[];
  meId: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  const lineRev = (l: IntakeLine) => (l.qty ?? 0) * (l.claimedPrice ?? 0);
  const orderRev = (o: IntakeRecord) => o.lines.reduce((s, l) => s + lineRev(l), 0);
  const grand = orders.reduce((s, o) => s + orderRev(o), 0);
  const lineCount = orders.reduce((s, o) => s + o.lines.length, 0);

  if (orders.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2 font-medium">SKU</th>
            <th className="px-3 py-2 font-medium">Customer wrote</th>
            <th className="px-3 py-2 font-medium text-right">Qty</th>
            <th className="px-3 py-2 font-medium text-right">Unit $</th>
            <th className="px-3 py-2 font-medium text-right">Line $</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const mine = o.status === "claimed" && o.claimedBy === meId;
            const skuQty = o.lines
              .filter((l) => l.sku)
              .map((l) => `${l.sku}\t${l.qty ?? ""}`)
              .join("\n");
            return (
              <Fragment key={o.id}>
                <tr className="border-t-2 border-slate-200 bg-slate-50/70">
                  <td colSpan={4} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-800">{o.debtorName ?? o.fromName ?? o.fromEmail}</span>
                      {o.debtorCode && <span className="font-mono text-xs text-slate-500">{o.debtorCode}</span>}
                      {o.poRef && <span className="text-xs text-slate-500">PO {o.poRef}</span>}
                      <StatusPill order={o} mine={mine} />
                      {o.seenInArrow && <Pill className="bg-emerald-100 text-emerald-700">✓ In Arrow</Pill>}
                      {skuQty && <CopyBtn value={skuQty} k={`qv-${o.id}`} copiedKey={copiedKey} onCopy={onCopy} />}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-700 whitespace-nowrap">{fmtMoney(orderRev(o))}</td>
                </tr>
                {o.lines.map((l, i) => (
                  <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">
                      {l.sku ?? <span className="text-rose-500">— no match —</span>}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">
                      <span className="block max-w-md truncate">{l.description ?? l.raw}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.qty ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{l.claimedPrice != null ? fmtMoney(l.claimedPrice) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtMoney(lineRev(l))}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 bg-slate-50">
            <td colSpan={2} className="px-3 py-2 text-xs text-slate-500">{orders.length} orders · {lineCount} lines</td>
            <td colSpan={2} className="px-3 py-2 text-right font-semibold text-slate-700">Total revenue</td>
            <td className="px-3 py-2 text-right font-bold text-slate-900 whitespace-nowrap">{fmtMoney(grand)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
