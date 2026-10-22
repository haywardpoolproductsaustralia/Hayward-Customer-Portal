// lib/containers/parse-chr.ts
// C.H. Robinson Navisphere "Hayward Pool Shipment Activity Report" (xlsx, sheet "Worksheet1").
// One row per CHR shipment (booking), NOT per PO line: Customer Reference Number carries the PO(s) for Wuxi
// bookings ("918214 918457 918494") but only a date or week for US bookings ("9/25", "week 34") — those are
// matched to PO lines on the page by AS400 ship date and shown as "probable".
// Container Number Summary is "N/A" until the box is assigned, and "A|B" for multi-container shipments.
// Scheduled copy arrives from CHRobinsonReports@chrobinson.com as a "View Report" link (Dimi's Navisphere login);
// the downloaded xlsx is what this parses. Columns confirmed from the 22 Oct 2026 file.

import * as XLSX from "xlsx";
import type { ChrStatus, ContainerRecord, ParseResult } from "./types";
import { ISO6346 } from "./types";

/** CHR "Shipment Status" → ShipsGo container-status vocabulary. */
export const CHR_STATUS: Record<string, string> = {
  "booked complete": "BOOKED", "booked": "BOOKED", "picked up": "GATE_IN", "gate in": "GATE_IN", "loaded": "LOADED",
  "depart port": "SAILING", "departed": "SAILING", "in transit": "SAILING", "arv'd port": "ARRIVED", "arrived port": "ARRIVED", "arrived": "ARRIVED",
  "unloaded": "DISCHARGED", "discharged": "DISCHARGED", "port cmplt": "GATE_OUT", "port complete": "GATE_OUT",
  "unloading": "GATE_OUT", "out for delivery": "GATE_OUT", "delivered": "GATE_OUT", "complete": "EMPTY_RETURN", "completed": "EMPTY_RETURN",
};
const US_PORTS = /los angeles|long beach|charleston|savannah|new york|norfolk|houston|oakland|seattle|tacoma|newark|baltimore/i;

const S = (v: unknown) => (v == null ? "" : String(v).trim());
const NA = (v: unknown) => { const s = S(v); return !s || /^n\/?a$/i.test(s) ? "" : s; };
function iso(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = S(v); if (!s || /^n\/?a$/i.test(s)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s); return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}
const col = (r: Record<string, unknown>, name: string) => { const k = Object.keys(r).find((k) => k.trim().toLowerCase() === name.toLowerCase()); return k ? r[k] : undefined; };

export function isChrReport(nameOrHeader: string): boolean {
  return /shipment[_ ]activity[_ ]report|navisphere|chrobinson/i.test(nameOrHeader) || (/CHR Shipment Number/i.test(nameOrHeader) && /Container Number Summary/i.test(nameOrHeader));
}

export function parseChrReport(buf: Buffer | Uint8Array, observedAt: string): ParseResult & { bookings: number } {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames.find((n) => /worksheet/i.test(n)) ?? wb.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: "" });
  const containers: Partial<ContainerRecord>[] = [];
  const warnings: string[] = [];
  let bookings = 0, bad = 0;
  if (!rows.length || col(rows[0], "CHR Shipment Number") === undefined) return { lines: [], containers: [], warnings: ["CHR: 'CHR Shipment Number' column not found"], bookings: 0 };

  for (const r of rows) {
    const shipmentNo = S(col(r, "CHR Shipment Number"));
    if (!shipmentNo) continue;
    const ref = S(col(r, "Customer Reference Number"));
    const pos = [...new Set([...ref.matchAll(/\b(9\d{5})\b/g)].map((m) => m[1]))];
    const nos = NA(col(r, "Container Number Summary")).split(/[|,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const statusRaw = S(col(r, "Shipment Status"));
    const origin = S(col(r, "Origin Port/Airport"));
    const shipper = S(col(r, "Shipper"));
    const st: ChrStatus = {
      shipmentNo, reference: ref || undefined, statusRaw, status: CHR_STATUS[statusRaw.toLowerCase()],
      etd: iso(col(r, "Origin Port/Airport Estimated Departure")), atd: iso(col(r, "Origin Port/Airport Departed")),
      eta: iso(col(r, "Destination Port/Airport Estimated Arrival")), ata: iso(col(r, "Destination Port/Airport Arrived")),
      pickedUpAt: iso(col(r, "Pickup From Departed")), deliverEta: iso(col(r, "Deliver To Estimated Arrival")), deliveredAt: iso(col(r, "Delivered")),
      carrier: S(col(r, "Main Carrier")) || undefined, hbl: NA(col(r, "HBL/HAWB Number")) || undefined, usOrigin: US_PORTS.test(origin), updatedAt: observedAt,
    };
    if (st.ata && (!st.status || st.status === "SAILING" || st.status === "BOOKED" || st.status === "GATE_IN")) st.status = "ARRIVED";
    if (st.deliveredAt) st.status = "GATE_OUT";
    if (!nos.length) { bookings++; continue; } // booked, no box yet — nothing to key a record on
    for (const no of nos) {
      if (!ISO6346.test(no)) { bad++; continue; }
      containers.push({
        containerNo: no, pos, lines: [], sources: ["chr"], firstSeen: observedAt, lastSeen: observedAt,
        mbl: NA(col(r, "MBL Number")) || undefined, hbl: st.hbl, forwarder: "C.H. Robinson", vendor: shipper || undefined,
        originPort: origin.replace(/^Port of\s+/i, "") || undefined, destPort: S(col(r, "Destination Port/Airport")).replace(/^Port\s+/i, "") || undefined,
        destCountry: S(col(r, "Destination Port/Airport Country")) || "AU",
        shipMode: /air/i.test(S(col(r, "Shipping Method")) + S(col(r, "Mode"))) ? "A" : "O",
        // "Conveyance" = "CMA CGM SEATTLE/639S"; "Mother Vessel Voyage Number/Flight" = "639S"
        vessel: NA(col(r, "Conveyance")).split("/")[0].trim() || undefined,
        voyage: NA(col(r, "Mother Vessel Voyage Number/Flight")) || NA(col(r, "Conveyance")).split("/")[1] || undefined,
        etd: st.atd ?? st.etd, eta: st.eta, deliveredDate: st.deliveredAt ?? (st.status === "GATE_OUT" || st.status === "EMPTY_RETURN" ? st.ata : undefined),
        size: NA(col(r, "Container Type Summary")) || undefined, chr: st,
      });
    }
  }
  if (bookings) warnings.push(`CHR: ${bookings} booking(s) have no container assigned yet (ETD only) — not stored`);
  if (bad) warnings.push(`CHR: ${bad} non-ISO container value(s) skipped`);
  return { lines: [], containers, warnings, bookings };
}
