"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IntakeRecord } from "@/lib/au-orders-inbox";

const POLL_MS = 7_000;
const HEARTBEAT_MS = 5 * 60_000;

type Toast = { text: string; tone: "info" | "warn" } | null;

export default function OrderInboxQueue({ meId, meName }: { meId: string; meName: string }) {
  const [pos, setPos] = useState<IntakeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showKeyed, setShowKeyed] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<Toast>(null);
  const showKeyedRef = useRef(showKeyed);
  showKeyedRef.current = showKeyed;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/au-orders-inbox${showKeyedRef.current ? "?includeKeyed=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Couldn't load the queue. Refresh to try again.");
      const data = await res.json();
      setPos(data.orders);
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

  useEffect(() => {
    const t = setInterval(() => {
      pos
        .filter((o) => o.status === "claimed" && o.claimedBy === meId)
        .forEach((o) => fetch(`/api/au-orders-inbox/${o.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "heartbeat" }),
        }).catch(() => {}));
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [pos, meId]);

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

  const active = pos.filter((o) => o.status !== "keyed");
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
      ) : pos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
          <p className="font-medium text-slate-700">Nothing in the queue.</p>
          <p className="mt-1 text-sm text-slate-500">Orders from the au-orders mailbox will appear here as they&apos;re processed.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pos.map((o) => (
            <IntakeCard key={o.id} item={o} meId={meId} busy={!!busy[o.id]} onAct={act} />
          ))}
        </div>
      )}
    </div>
  );
}

function IntakeCard({
  item, meId, busy, onAct,
}: {
  item: IntakeRecord;
  meId: string;
  busy: boolean;
  onAct: (id: string, action: "claim" | "release" | "key") => void;
}) {
  const mineClaim = item.status === "claimed" && item.claimedBy === meId;
  const otherClaim = item.status === "claimed" && item.claimedBy !== meId;
  const keyed = item.status === "keyed";

  return (
    <article className={`rounded-lg border p-4 ${otherClaim ? "border-amber-200 bg-amber-50/40" : mineClaim ? "border-emerald-300 bg-emerald-50/40" : keyed ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{item.debtorName ?? item.fromName ?? item.fromEmail}</span>
            {item.debtorCode ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{item.debtorCode}</span>
            ) : (
              <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">Unresolved customer</span>
            )}
            {item.duplicateOf && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">Possible duplicate</span>}
            {item.extractionConfidence === "low" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Needs checking</span>}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {item.fromEmail}
            {item.poRef ? ` · PO ${item.poRef}` : " · no PO ref"}
            {` · ${new Date(item.receivedAt).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <StatusPill item={item} mine={mineClaim} />
      </div>

      <div className="mt-3 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
        {item.deliverBy && <div><span className="text-slate-400">Deliver by:</span> {item.deliverBy}</div>}
        {item.deliverTo && <div><span className="text-slate-400">To:</span> {item.deliverTo}</div>}
        {item.contact && <div><span className="text-slate-400">Contact:</span> {item.contact}</div>}
      </div>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-1 font-medium">Qty</th>
            <th className="py-1 font-medium">Customer wrote</th>
            <th className="py-1 font-medium">Matched SKU</th>
          </tr>
        </thead>
        <tbody>
          {item.lines.map((l, i) => (
            <tr key={i} className="border-t border-slate-100 align-top">
              <td className="py-1.5 pr-2 tabular-nums">{l.qty ?? "?"}{l.unit ? ` ${l.unit}` : ""}</td>
              <td className="py-1.5 pr-2 text-slate-700">{l.raw}</td>
              <td className="py-1.5">
                {l.sku ? (
                  <span><span className="font-medium text-slate-900">{l.sku}</span>{l.description ? <span className="text-slate-500"> — {l.description}</span> : null}</span>
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

      {item.notes && <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">{item.notes}</p>}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {item.emailWebUrl ? (
          <a href={item.emailWebUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-sky-700 hover:underline">
            Open original email ↗
          </a>
        ) : <span />}

        <div className="flex gap-2">
          {keyed ? (
            <span className="text-xs text-slate-500">Keyed by {item.keyedByName}{item.keyedAt ? ` · ${new Date(item.keyedAt).toLocaleTimeString("en-AU", { timeZone: "Australia/Melbourne", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
          ) : otherClaim ? (
            <span className="text-xs font-medium text-amber-700">🔒 {item.claimedByName} is keying this</span>
          ) : mineClaim ? (
            <>
              <button disabled={busy} onClick={() => onAct(item.id, "release")} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Release</button>
              <button disabled={busy} onClick={() => onAct(item.id, "key")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Mark as keyed</button>
            </>
          ) : (
            <button disabled={busy} onClick={() => onAct(item.id, "claim")} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">Claim</button>
          )}
        </div>
      </div>
    </article>
  );
}

function StatusPill({ item, mine }: { item: IntakeRecord; mine: boolean }) {
  if (item.status === "keyed") return <Pill className="bg-slate-200 text-slate-600">Keyed</Pill>;
  if (mine) return <Pill className="bg-emerald-100 text-emerald-700">Claimed by you</Pill>;
  if (item.status === "claimed") return <Pill className="bg-amber-100 text-amber-800">Being keyed</Pill>;
  return <Pill className="bg-sky-100 text-sky-700">New</Pill>;
}

function Pill({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}
