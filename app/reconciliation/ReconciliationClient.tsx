"use client";
/* app/reconciliation/ReconciliationClient.tsx
   Renders the engine's ReconLine[] directly (status/flags/eta are computed
   server-side in lib/recon/reconcile.ts, so nothing is recomputed here).
*/

import React, { useMemo, useState } from "react";
import { Package, Ship, Database, AlertTriangle, CheckCircle2, XCircle, Search, ChevronDown, ChevronRight, Anchor, CircleDashed } from "lucide-react";
import type { ReconLine } from "@/lib/recon/reconcile";

type Summary = { total: number; exceptions: number; inTransit: number; delivered: number; awaiting: number; late: number };
type Meta = { generatedAt: string; shipmentReceivedAt: string; shipmentSubject: string; arrowLines: number; as400Rows: number };

const C = {
  bg: "#0b1017", panel: "#111823", panel2: "#0e141d", line: "#1e2a38",
  ink: "#e8eef5", sub: "#8ba0b6", faint: "#5b6f85",
  aqua: "#37d3c4", green: "#3ecf8e", amber: "#f0b64b", red: "#f0715a", blue: "#5aa9f0", grey: "#6b7f96",
};

const HEAD_META: Record<ReconLine["head"], { label: string; color: string }> = {
  matched: { label: "Matched", color: C.green },
  delivered: { label: "Delivered", color: C.green },
  qty_mismatch: { label: "Qty mismatch", color: C.amber },
  missing_at_supplier: { label: "Missing at supplier", color: C.red },
  cancelled: { label: "Cancelled", color: C.red },
  in_transit: { label: "In transit", color: C.blue },
  awaiting_shipment: { label: "Awaiting shipment", color: C.grey },
};

function fmtDate(s: string | null) {
  if (!s) return "\u2014";
  return new Date(s + "T00:00:00").toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

/* stage colours for the flow track, derived from the engine output */
function stages(r: ReconLine) {
  let as: string, sh: string;
  if (!r.as400) as = C.red;
  else if (r.head === "cancelled") as = C.red;
  else if (r.head === "qty_mismatch") as = C.amber;
  else as = C.aqua;
  if (r.shipment?.delivered) sh = C.green;
  else if (r.shipment?.eta) sh = C.blue;
  else sh = C.grey;
  const asFilled = !!r.as400 && r.head !== "cancelled";
  const shFilled = !!r.shipment && (!!r.shipment.delivered || !!r.shipment.eta);
  return { as, sh, asFilled, shFilled, broke: !r.as400 || r.head === "cancelled" };
}

function FlowTrack({ r }: { r: ReconLine }) {
  const s = stages(r);
  const dot = (color: string, filled: boolean, icon: React.ReactNode) => (
    <div style={{ width: 26, height: 26, borderRadius: 13, display: "grid", placeItems: "center",
      background: filled ? color : "transparent", border: `1.5px solid ${color}`,
      color: filled ? C.bg : color, boxShadow: filled ? `0 0 12px ${color}55` : "none" }}>{icon}</div>
  );
  const conn = (color: string) => <div style={{ flex: 1, height: 2, background: color, opacity: 0.55, marginTop: 12, minWidth: 18 }} />;
  return (
    <div style={{ display: "flex", alignItems: "flex-start" }}>
      {dot(C.aqua, true, <Package size={14} />)}
      {conn(s.broke ? C.red : C.aqua)}
      {dot(s.as, s.asFilled, s.broke ? <XCircle size={14} /> : r.head === "qty_mismatch" ? <AlertTriangle size={14} /> : <Database size={14} />)}
      {conn(s.broke ? C.line : s.sh)}
      {dot(s.sh, s.shFilled, r.shipment?.delivered ? <CheckCircle2 size={14} /> : r.shipment?.eta ? <Ship size={14} /> : <CircleDashed size={14} />)}
    </div>
  );
}

function Detail({ icon, title, color, rows }: { icon: React.ReactNode; title: string; color: string; rows: [string, string][] }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, color, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{icon}{title}</div>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0", fontSize: 12.5 }}>
          <span style={{ color: C.faint }}>{k}</span>
          <span style={{ color: C.ink, fontFamily: "ui-monospace, Menlo, monospace", textAlign: "right" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Row({ r, open, onToggle }: { r: ReconLine; open: boolean; onToggle: () => void }) {
  const hm = HEAD_META[r.head];
  const etaColor = r.etaKind === "delivered" ? C.green : r.etaKind === "container_eta" ? C.blue : C.sub;
  const etaLabel = r.etaKind === "delivered" ? "delivered" : r.etaKind === "container_eta" ? "container ETA" : r.etaKind === "supplier_promise" ? "supplier promise" : "no date";
  return (
    <div style={{ borderBottom: `1px solid ${C.line}` }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: "18px 150px 1fr 200px 160px", gap: 14, alignItems: "center", padding: "12px 14px", cursor: "pointer" }}>
        <div style={{ color: C.faint }}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</div>
        <div>
          <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, color: C.ink, fontWeight: 600 }}>{r.arrowStock}</div>
          <div style={{ fontSize: 11, color: C.faint }}>{r.supplierSku || "no supplier sku"}</div>
        </div>
        <FlowTrack r={r} />
        <div>
          <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, color: hm.color, background: hm.color + "1a", border: `1px solid ${hm.color}44` }}>{hm.label}</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, color: etaColor }}>{fmtDate(r.eta)}</div>
          <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {etaLabel}{r.daysLate != null && r.daysLate > 0 ? ` \u00b7 ${r.daysLate}d late` : ""}
          </div>
        </div>
      </div>
      {open && (
        <div style={{ padding: "4px 14px 18px 46px", display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, background: C.panel2 }}>
          <Detail icon={<Package size={13} />} title="Arrow (ordered)" color={C.aqua} rows={[
            ["Stock code", r.arrowStock], ["Supplier SKU", r.supplierSku || "\u2014"], ["Qty ordered", String(r.qtyOrdered)],
          ]} />
          <Detail icon={<Database size={13} />} title="AS400 (supplier entry)" color={r.as400 ? (r.head === "qty_mismatch" ? C.amber : C.green) : C.red}
            rows={r.as400 ? [
              ["Qty entered", String(r.as400.orderedQty)], ["Qty shipped", String(r.as400.shippedQty)],
              ["Promise date", fmtDate(r.as400.promiseDate)], ["US sales order", r.as400.usSalesOrder ?? "\u2014"],
              ["Cancelled", r.as400.anyCancelled ? "YES" : "no"],
            ] : [["Status", "Never entered into the supplier system"]]} />
          <Detail icon={<Ship size={13} />} title="Shipment portal" color={r.shipment ? (r.shipment.delivered ? C.green : C.blue) : C.grey}
            rows={r.shipment ? [
              ["Container", r.shipment.container ?? "\u2014"], ["Vessel", r.shipment.vessel ?? "\u2014"],
              ["ETD \u2192 ETA", `${fmtDate(r.shipment.etd)} \u2192 ${fmtDate(r.shipment.eta)}`],
              ["Delivered", fmtDate(r.shipment.delivered)],
              ["Route", `${r.shipment.origin ?? "?"} \u2192 ${r.shipment.destPort ?? "?"}`],
              ...(r.shipmentCount > 1 ? [["Other containers", `${r.shipmentCount - 1} more`] as [string, string]] : []),
            ] : [["Status", "No AU/NZ container matched yet"]]} />
          {r.flags.length > 0 && (
            <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
              {r.flags.map((f, i) => {
                const col = f.severity === "error" ? C.red : f.severity === "warn" ? C.amber : C.blue;
                return <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: col, background: col + "14", border: `1px solid ${col}3a`, borderRadius: 6, padding: "5px 10px" }}><AlertTriangle size={12} /> {f.text}</span>;
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: color ?? C.ink, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function ReconciliationClient({ lines, summary, meta }: { lines: ReconLine[]; summary: Summary; meta: Meta }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "exceptions" | "transit" | "delivered" | "pending">("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const shown = useMemo(() => lines.filter((r) => {
    if (filter === "exceptions" && !(r.head === "missing_at_supplier" || r.head === "cancelled" || r.head === "qty_mismatch")) return false;
    if (filter === "transit" && r.head !== "in_transit") return false;
    if (filter === "delivered" && r.head !== "delivered") return false;
    if (filter === "pending" && r.head !== "awaiting_shipment") return false;
    if (q && !(`${r.po} ${r.arrowStock} ${r.supplierSku}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  }), [lines, filter, q]);

  const byPo = useMemo(() => {
    const m: Record<string, ReconLine[]> = {};
    shown.forEach((r) => { (m[r.po] = m[r.po] || []).push(r); });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  const chip = (id: typeof filter, label: string, color?: string) => (
    <button onClick={() => setFilter(id)} style={{
      padding: "6px 12px", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
      background: filter === id ? (color ?? C.aqua) + "22" : "transparent",
      border: `1px solid ${filter === id ? (color ?? C.aqua) : C.line}`,
      color: filter === id ? (color ?? C.aqua) : C.sub,
    }}>{label}</button>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: "Inter, system-ui, sans-serif", padding: "24px 22px 60px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 20 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Anchor size={22} color={C.aqua} />
              <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>Order Reconciliation & ETA</h1>
            </div>
            <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6 }}>Arrow POs vs. AS400 supplier entry vs. CDS-Net shipment portal \u00b7 Australia & New Zealand</div>
          </div>
          <div style={{ textAlign: "right", fontSize: 11, color: C.faint, lineHeight: 1.7 }}>
            <div>shipment file \u00b7 {fmtDate(meta.shipmentReceivedAt?.slice(0, 10))}</div>
            <div>reconciled \u00b7 {new Date(meta.generatedAt).toLocaleString("en-AU")}</div>
            <div>{meta.arrowLines} Arrow lines \u00b7 {meta.as400Rows} AS400 rows</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <Stat label="PO lines" value={summary.total} />
          <Stat label="Exceptions" value={summary.exceptions} color={C.amber} />
          <Stat label="In transit" value={summary.inTransit} color={C.blue} />
          <Stat label="Delivered" value={summary.delivered} color={C.green} />
          <Stat label="Late vs. request" value={summary.late} color={C.red} />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 12px", flex: "1 1 220px", maxWidth: 300 }}>
            <Search size={15} color={C.faint} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PO or SKU\u2026" style={{ background: "transparent", border: "none", outline: "none", color: C.ink, fontSize: 13, width: "100%" }} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {chip("all", "All")}{chip("exceptions", "Exceptions", C.amber)}{chip("transit", "In transit", C.blue)}{chip("delivered", "Delivered", C.green)}{chip("pending", "Awaiting ship", C.grey)}
          </div>
        </div>

        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
          {byPo.length === 0 && <div style={{ padding: "48px 20px", textAlign: "center", color: C.faint, fontSize: 13 }}>No lines match this filter.</div>}
          {byPo.map(([po, rows]) => (
            <div key={po}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: C.panel, borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: "0.08em" }}>PO</span>
                  <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, fontWeight: 700, color: C.aqua }}>{po}</span>
                </div>
                <span style={{ fontSize: 11.5, color: C.sub }}>{rows.length} line{rows.length > 1 ? "s" : ""}</span>
              </div>
              {rows.map((r) => {
                const key = `${po}-${r.line}-${r.arrowStock}`;
                return <Row key={key} r={r} open={!!open[key]} onToggle={() => setOpen((o) => ({ ...o, [key]: !o[key] }))} />;
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
