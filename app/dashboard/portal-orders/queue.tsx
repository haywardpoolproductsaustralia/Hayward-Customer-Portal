"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalOrder } from "@/lib/portal-orders";
import { Copy, Check, ChevronRight, Lock, Download, AlertTriangle, ShoppingCart } from "lucide-react";
import * as XLSX from "xlsx";

const POLL_MS = 7_000;
const HEARTBEAT_MS = 5 * 60_000;

const fmtMoney = (n: number | null) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// YYYY-MM-DD in Melbourne time, so date filters line up with what's on screen
// rather than with the browser's UTC day boundary.
const melbDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

// Loose match: case-insensitive, ignoring spaces/dashes/slashes so "PO-4521"
// is found by typing "4521" or "po 4521".
const loose = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

type Toast = { text: string; tone: "info" | "warn" } | null;

export default function PortalOrderQueue({ meId, meName }: { meId: string; meName: string }) {
  const [orders, setOrders] = useState<PortalOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<Toast>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [fCode, setFCode] = useState("");
  const [fName, setFName] = useState("");
  const [fPo, setFPo] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");

  const showClosedRef = useRef(showClosed);
  showClosedRef.current = showClosed;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal-orders${showClosedRef.current ? "?includeClosed=1" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Couldn't load the queue. Refresh to try again.");
      const data = await res.json();
      setOrders(data.orders ?? []);
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

  useEffect(() => {
    load();
  }, [showClosed, load]);

  // Keep my own claims alive while I'm actually on the page, so a long keying
  // session doesn't quietly hand my order to someone else mid-way.
  useEffect(() => {
    const t = setInterval(() => {
      orders
        .filter((o) => o.status === "claimed" && o.claimedBy === meId)
        .forEach((o) => {
          fetch(`/api/portal-orders/${o.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "heartbeat" }),
          }).catch(() => {});
        });
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [orders, meId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/portal-orders/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          data.reason === "taken"
            ? `${data.by} is already working on that one.`
            : data.reason === "already_keyed"
              ? "That order has already been keyed."
              : data.reason === "not_owner"
                ? "Your claim on that order expired - claim it again."
                : "That didn't go through.";
        setToast({ text: msg, tone: "warn" });
      }
      await load();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  function copy(text: string, tag: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  /** The whole order as tab-separated SKU/qty, for pasting into Arrow. */
  function copyLines(o: PortalOrder) {
    copy(o.lines.map((l) => `${l.sku}\t${l.qty}`).join("\n"), `lines-${o.id}`);
  }

  const filtered = orders.filter((o) => {
    if (fCode && !loose(o.debtorCode).includes(loose(fCode))) return false;
    if (fName && !loose(o.debtorName).includes(loose(fName))) return false;
    if (fPo && !(loose(o.poRef).includes(loose(fPo)) || loose(o.ref).includes(loose(fPo)))) return false;
    const day = melbDay(o.submittedAt);
    if (fFrom && day < fFrom) return false;
    if (fTo && day > fTo) return false;
    return true;
  });

  function exportXlsx() {
    const rows = filtered.flatMap((o) =>
      o.lines.map((l) => ({
        Reference: o.ref,
        Status: o.status,
        Account: o.debtorCode,
        "Account name": o.debtorName ?? "",
        "Customer PO": o.poRef,
        Submitted: fmtTime(o.submittedAt),
        "Submitted by": o.submittedByName,
        "Required by": o.requiredBy ?? "",
        SKU: l.sku,
        Description: l.description ?? "",
        Qty: l.qty,
        "Unit price": l.unitPriceServer ?? "",
        "Line total": l.lineTotal ?? "",
        "Arrow order": o.arrowOrderNo ?? "",
      }))
    );
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Portal orders");
    XLSX.writeFile(wb, `portal-orders-${melbDay(Date.now())}.xlsx`);
  }

  const mismatchCount = filtered.filter((o) => o.lines.some((l) => l.priceMismatch)).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-deep font-bold">Portal orders</h1>
          <p className="text-ink/50 mt-1">
            Orders customers raised themselves on the portal. Account code and SKUs are already confirmed - these
            just need keying into Arrow.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-ink/50">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            Show keyed / cancelled
          </label>
          {filtered.length > 0 && (
            <button
              onClick={exportXlsx}
              className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-wave/30 flex items-center gap-2"
            >
              <Download className="h-4 w-4" /> Export
            </button>
          )}
        </div>
      </div>

      {mismatchCount > 0 && (
        <div className="rounded-xl bg-amber/10 border border-amber/30 px-4 py-3 text-sm text-ink/70 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber flex-shrink-0 mt-0.5" />
          <span>
            {mismatchCount} order{mismatchCount === 1 ? "" : "s"} shown a price that differs from what the pricing
            engine recomputed at submit. Check those lines before keying - the recomputed price is the one stored.
          </span>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-5 rounded-2xl bg-white border border-ink/10 shadow-soft p-4">
        <input
          value={fCode}
          onChange={(e) => setFCode(e.target.value)}
          placeholder="Account code"
          className="rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
        />
        <input
          value={fName}
          onChange={(e) => setFName(e.target.value)}
          placeholder="Account name"
          className="rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
        />
        <input
          value={fPo}
          onChange={(e) => setFPo(e.target.value)}
          placeholder="Customer PO or WEB ref"
          className="rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
        />
        <input
          type="date"
          value={fFrom}
          onChange={(e) => setFFrom(e.target.value)}
          className="rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
        />
        <input
          type="date"
          value={fTo}
          onChange={(e) => setFTo(e.target.value)}
          className="rounded-lg border border-ink/10 px-3 py-2 text-sm focus:border-wave outline-none"
        />
      </div>

      {error && (
        <div className="rounded-xl bg-coral/10 border border-coral/30 px-4 py-3 text-sm text-ink/70">{error}</div>
      )}

      {loading ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 text-center text-ink/40">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <ShoppingCart className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No portal orders waiting.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((o) => {
            const mine = o.claimedBy === meId;
            const lockedByOther = o.status === "claimed" && !mine;
            const open = expanded[o.id];
            const hasMismatch = o.lines.some((l) => l.priceMismatch);

            return (
              <div key={o.id} className="rounded-2xl bg-white border border-ink/10 shadow-soft overflow-hidden">
                <div className="px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [o.id]: !e[o.id] }))}
                    className="flex items-start gap-3 text-left flex-1 min-w-0"
                  >
                    <ChevronRight
                      className={`h-4 w-4 mt-1 text-ink/30 transition-transform ${open ? "rotate-90" : ""}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-deep">{o.ref}</span>
                        <span className="font-medium text-ink truncate">{o.debtorName ?? o.debtorCode}</span>
                        <span className="font-mono text-xs text-ink/40">{o.debtorCode}</span>
                        {o.duplicateOf && (
                          <span className="rounded-full bg-amber/15 text-amber px-2 py-0.5 text-xs font-medium">
                            possible duplicate
                          </span>
                        )}
                        {hasMismatch && (
                          <span className="rounded-full bg-amber/15 text-amber px-2 py-0.5 text-xs font-medium">
                            price differs
                          </span>
                        )}
                        {o.status === "keyed" && (
                          <span className="rounded-full bg-splash/15 text-splash px-2 py-0.5 text-xs font-medium">
                            keyed
                          </span>
                        )}
                        {o.status === "cancelled" && (
                          <span className="rounded-full bg-coral/15 text-coral px-2 py-0.5 text-xs font-medium">
                            cancelled
                          </span>
                        )}
                        {o.seenInArrow && o.arrowOrderNo && (
                          <span className="rounded-full bg-wave/15 text-wave px-2 py-0.5 text-xs font-medium">
                            Arrow {o.arrowOrderNo}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-ink/50 mt-1">
                        PO {o.poRef} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"} ·{" "}
                        {fmtMoney(o.subTotal)} · {fmtTime(o.submittedAt)} · {o.submittedByName}
                        {o.requiredBy ? ` · required ${o.requiredBy}` : ""}
                      </p>
                    </div>
                  </button>

                  <div className="flex items-center gap-2">
                    {lockedByOther && (
                      <span className="flex items-center gap-1.5 text-xs text-ink/40">
                        <Lock className="h-3.5 w-3.5" /> {o.claimedByName}
                      </span>
                    )}
                    {o.status === "new" && (
                      <button
                        onClick={() => act(o.id, "claim")}
                        disabled={busy[o.id]}
                        className="rounded-xl bg-wave text-white px-4 py-2 text-sm font-semibold hover:bg-deep disabled:opacity-50"
                      >
                        Claim
                      </button>
                    )}
                    {mine && o.status === "claimed" && (
                      <>
                        <button
                          onClick={() => act(o.id, "release")}
                          disabled={busy[o.id]}
                          className="rounded-xl border border-ink/10 px-3 py-2 text-sm font-medium disabled:opacity-50"
                        >
                          Release
                        </button>
                        <button
                          onClick={() => {
                            const reason = window.prompt("Why is this order being cancelled?");
                            if (reason && reason.trim()) act(o.id, "cancel", { reason: reason.trim() });
                          }}
                          disabled={busy[o.id]}
                          className="rounded-xl border border-coral/30 text-coral px-3 py-2 text-sm font-medium disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => act(o.id, "key")}
                          disabled={busy[o.id]}
                          className="rounded-xl bg-splash text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
                        >
                          Mark keyed
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {open && (
                  <div className="border-t border-ink/10 px-5 py-4 space-y-4 bg-foam/40">
                    <div className="grid gap-3 sm:grid-cols-2 text-sm">
                      <div>
                        <p className="text-xs text-ink/40">Deliver to</p>
                        <p className="text-ink/70">{o.deliverTo ?? "-"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-ink/40">Site contact</p>
                        <p className="text-ink/70">
                          {[o.contact, o.phone].filter(Boolean).join(" · ") || "-"}
                        </p>
                      </div>
                      <div className="sm:col-span-2">
                        <p className="text-xs text-ink/40">Customer notes</p>
                        <p className="text-ink/70">{o.notes ?? "-"}</p>
                      </div>
                      {o.cancelReason && (
                        <div className="sm:col-span-2">
                          <p className="text-xs text-ink/40">Cancelled because</p>
                          <p className="text-coral">{o.cancelReason}</p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => copyLines(o)}
                        className="flex items-center gap-1.5 text-xs rounded-lg border border-ink/10 bg-white px-3 py-1.5 font-medium"
                      >
                        {copied === `lines-${o.id}` ? (
                          <Check className="h-3.5 w-3.5 text-splash" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-ink/40" />
                        )}
                        Copy SKU + qty
                      </button>
                      <button
                        onClick={() => copy(o.poRef, `po-${o.id}`)}
                        className="flex items-center gap-1.5 text-xs rounded-lg border border-ink/10 bg-white px-3 py-1.5 font-medium"
                      >
                        {copied === `po-${o.id}` ? (
                          <Check className="h-3.5 w-3.5 text-splash" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-ink/40" />
                        )}
                        Copy PO
                      </button>
                      <button
                        onClick={() => copy(o.debtorCode, `code-${o.id}`)}
                        className="flex items-center gap-1.5 text-xs rounded-lg border border-ink/10 bg-white px-3 py-1.5 font-medium"
                      >
                        {copied === `code-${o.id}` ? (
                          <Check className="h-3.5 w-3.5 text-splash" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-ink/40" />
                        )}
                        Copy account
                      </button>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-ink/10 text-left text-ink/40">
                            <th className="px-4 py-2.5 font-medium">SKU</th>
                            <th className="px-4 py-2.5 font-medium">Description</th>
                            <th className="px-4 py-2.5 font-medium text-right">Qty</th>
                            <th className="px-4 py-2.5 font-medium text-right">Free stock</th>
                            <th className="px-4 py-2.5 font-medium text-right">Unit price</th>
                            <th className="px-4 py-2.5 font-medium text-right">Line total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {o.lines.map((l) => (
                            <tr key={l.sku} className="border-b border-ink/5 last:border-0">
                              <td className="px-4 py-2.5 font-mono text-xs">{l.sku}</td>
                              <td className="px-4 py-2.5 text-ink/70">{l.description ?? "-"}</td>
                              <td className="px-4 py-2.5 text-right font-semibold">{l.qty}</td>
                              <td
                                className={`px-4 py-2.5 text-right ${
                                  l.onHandAtSubmit != null && l.onHandAtSubmit < l.qty ? "text-amber" : "text-ink/40"
                                }`}
                              >
                                {l.onHandAtSubmit ?? "-"}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {fmtMoney(l.unitPriceServer)}
                                {l.priceMismatch && (
                                  <div className="text-xs text-amber">
                                    shown {fmtMoney(l.unitPriceQuoted)}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right font-semibold text-deep">
                                {fmtMoney(l.lineTotal)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-foam">
                            <td className="px-4 py-3 font-semibold text-deep" colSpan={5}>
                              Total (ex GST) · price type {o.priceType ?? "-"}
                            </td>
                            <td className="px-4 py-3 text-right font-bold text-deep">{fmtMoney(o.subTotal)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 rounded-xl px-4 py-3 text-sm shadow-soft ${
            toast.tone === "warn" ? "bg-amber text-white" : "bg-deep text-white"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
