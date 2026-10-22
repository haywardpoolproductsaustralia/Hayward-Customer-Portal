// lib/containers/parse-schedule.ts
// Dimi's hand-kept "Shipment Schedule.xlsx" (OneDrive). One row per container; both sheets (Sheet1 current,
// Sheet2 history). Header row 3: Suppliers | (vessel) | Container Number | Invoice no / PO number | (forwarder) |
// Date dispatch | Date delivery | (revised ETA) | Revised Delivery Date | Note | P/O's | Warehouse Location | items…
//
// What it adds that no feed has: the revised warehouse-delivery date, customer notes (POOLPRO, SALTMATE), warehouse
// location, third-party suppliers (Sugar Valley, Pioneer, Rowin…), and — most useful — the invoice numbers per
// container, which resolve to POs and lines through the invoice index the US-invoice parser maintains (ct:inv:*).
// Invoice lists are abbreviated ("13455736, 737, 739, 740") and are expanded against the previous full number.

import * as XLSX from "xlsx";
import type { ContainerRecord, ParseResult, ScheduleStatus } from "./types";
import { ISO6346 } from "./types";

const S = (v: unknown) => (v == null ? "" : String(v).trim());
function date(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = S(v); if (!s) return undefined;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return s.slice(0, 10);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);           // dd/mm/yyyy (Australian)
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(s);                     // "4-Nov" — assume current year
  if (m) { const mo = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[2].toLowerCase()) / 3; if (mo >= 0) return `${new Date().getFullYear()}-${String(mo + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return undefined;
}

/** "13455736, 737, 739, 90784741, 742" → ["13455736","13455737","13455739","90784741","90784742"] */
export function expandInvoiceList(text: string): string[] {
  const out: string[] = [];
  let prev = "";
  for (const tok of text.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean)) {
    const t = tok.replace(/[^0-9A-Za-z\/]/g, "");
    if (!t) continue;
    if (/^\d+$/.test(t) && prev && t.length < prev.length) { const full = prev.slice(0, prev.length - t.length) + t; out.push(full); prev = full; }
    else { out.push(t); if (/^\d+$/.test(t)) prev = t; }
  }
  return [...new Set(out)];
}

export function isScheduleWorkbook(nameOrHeader: string): boolean {
  return /shipment[_ ]schedule/i.test(nameOrHeader) || (/Container Number/i.test(nameOrHeader) && /Invoice no/i.test(nameOrHeader) && /Date delivery/i.test(nameOrHeader));
}

export function parseScheduleWorkbook(buf: Buffer | Uint8Array, observedAt: string): ParseResult {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const containers = new Map<string, Partial<ContainerRecord>>();
  const warnings: string[] = [];
  let rowsSeen = 0, noBox = 0;

  for (const name of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    const hIdx = rows.findIndex((r) => Array.isArray(r) && r.some((c) => /^Container Numb/i.test(S(c))));
    if (hIdx < 0) continue;
    const hdr = (rows[hIdx] as unknown[]).map((h) => S(h).toLowerCase());
    const col = (re: RegExp, fallback: number) => { const i = hdr.findIndex((h) => re.test(h)); return i >= 0 ? i : fallback; };
    const C = {
      supplier: col(/^suppliers?$/, 0), container: col(/^container numb/, 2), invoices: col(/^invoice no/, 3), forwarder: 4,
      dispatch: col(/^date dispatch/, 5), delivery: col(/^date delivery/, 6), revised: col(/^revised delivery/, 8),
      note: col(/^note$/, 9), pos: col(/^p\/o/, 10), location: col(/^warehouse location/, 11), items: 12,
    };
    for (const r of rows.slice(hIdx + 1)) {
      if (!Array.isArray(r)) continue;
      const no = S(r[C.container]).toUpperCase().replace(/\s/g, "");
      const supplier = S(r[C.supplier]);
      if (!supplier && !no) continue;
      rowsSeen++;
      if (!ISO6346.test(no)) { noBox++; continue; }
      const invoices = expandInvoiceList(S(r[C.invoices]));
      const pos = [...new Set([...S(r[C.pos]).matchAll(/\b(9\d{5})\b/g), ...S(r[C.invoices]).matchAll(/\bPO\s*(9\d{5})\b/gi)].map((m) => m[1]))];
      const items = (r as unknown[]).slice(C.items).map(S).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const st: ScheduleStatus = {
        supplier: supplier || undefined, forwarder: S(r[C.forwarder]) || undefined,
        dispatched: date(r[C.dispatch]), eta: date(r[C.delivery]), revisedDelivery: date(r[C.revised]),
        note: S(r[C.note]) || undefined, location: S(r[C.location]) || undefined, items: items || undefined,
        invoiceNos: invoices, updatedAt: observedAt, sheet: name,
      };
      const prev = containers.get(no);
      if (prev?.schedule) { // duplicate row (MSCU5375599 appears twice) — union invoices/items, keep the first dates
        prev.schedule.invoiceNos = [...new Set([...prev.schedule.invoiceNos, ...invoices])];
        prev.schedule.items = [prev.schedule.items, items].filter(Boolean).join("; ") || undefined;
        prev.schedule.note = prev.schedule.note ?? st.note; prev.schedule.revisedDelivery = prev.schedule.revisedDelivery ?? st.revisedDelivery;
        prev.invoiceNos = prev.schedule.invoiceNos; prev.pos = [...new Set([...(prev.pos ?? []), ...pos])];
        continue;
      }
      containers.set(no, {
        containerNo: no, pos, lines: [], sources: ["schedule"], firstSeen: observedAt, lastSeen: observedAt,
        vendor: supplier || undefined, forwarder: st.forwarder, etd: st.dispatched, eta: st.eta,
        deliveredDate: /delivered/i.test(st.note ?? "") ? (st.revisedDelivery ?? st.eta) : undefined,
        invoiceNos: invoices.filter((i) => /^\d{7,10}$/.test(i)), schedule: st,
      });
    }
  }
  if (noBox) warnings.push(`Schedule: ${noBox} row(s) without an ISO container number skipped (air / LCL / blank)`);
  if (!containers.size) warnings.push("Schedule: no container rows found — is this the Shipment Schedule workbook?");
  return { lines: [], containers: [...containers.values()], warnings };
}
