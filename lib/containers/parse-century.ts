// lib/containers/parse-century.ts
// Century / VIZIV dashboard export ("izi-all-containers-shipped-to-australia-or-n-YYYYMMDD-HHMMSS.csv"):
// one row per PO line per container, with the forwarder's live tracking — latest event, current ETA, vessel
// actual arrival. More current than the CDS xlsx and the only document source with event dates, so it ranks
// above CDS. Null dates come through as "1899-12-31". Air rows carry the HAWB in the container column.
//
// Columns (22 Oct 2026): Ship Key, Container Number, MBL, Carrier SCAC (= forwarder: CHSL / FLXT / EXDO),
// Vessel, Ship Mode, Departure Date, Current ETA, Vessel Actual Arrival, Final Delivery Actual, Latest Event,
// Latest Event Date, PO Number, PO Item, Units, Cartons, CBM

import * as XLSX from "xlsx";
import type { CenturyStatus, ContainerLine, ContainerRecord, ParseResult } from "./types";
import { ISO6346 } from "./types";

/** Century event wording → ShipsGo container-status vocabulary (so the page has one set of labels). */
export const CENTURY_EVENT_STATUS: Record<string, string> = {
  "ingate": "GATE_IN", "gate in": "GATE_IN", "loaded": "LOADED", "loaded on vessel": "LOADED",
  "vessel departed": "SAILING", "vessel departure": "SAILING", "transshipment": "SAILING",
  "vessel arrived": "ARRIVED", "vessel arrive": "ARRIVED", "unloaded from vessel": "DISCHARGED", "unloaded vessel": "DISCHARGED",
  "outgate": "GATE_OUT", "gate out": "GATE_OUT", "delivered": "GATE_OUT", "empty returned": "EMPTY_RETURN", "returned container": "EMPTY_RETURN",
};
const DONE = new Set(["GATE_OUT", "EMPTY_RETURN"]);

const S = (v: unknown) => (v == null ? "" : String(v).trim());
const date = (v: unknown) => { const s = S(v); return !s || s.startsWith("1899") ? undefined : s.slice(0, 10); };

/** Does this CSV look like the Century export? (header sniff, for routing) */
export function isCenturyCsv(nameOrHeader: string): boolean {
  return /izi-all-containers|century|viziv/i.test(nameOrHeader) || (/Ship Key/.test(nameOrHeader) && /Container Number/.test(nameOrHeader) && /Latest Event/.test(nameOrHeader));
}

export function parseCenturyCsv(buf: Buffer | string, observedAt: string): ParseResult {
  const wb = XLSX.read(buf, { type: typeof buf === "string" ? "string" : "buffer", raw: true });
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: "" });
  const lines: ContainerLine[] = [];
  const containers = new Map<string, Partial<ContainerRecord>>();
  const warnings: string[] = [];
  let air = 0, nonPo = 0;

  for (const r of rows) {
    const containerNo = S(r["Container Number"] ?? r.CONTAINERNUMBER).toUpperCase();
    const po = S(r["PO Number"] ?? r.PURCHASEORDERNUMBER);
    if (!/^\d{6}$/.test(po)) { nonPo++; continue; }               // FREE20260826 samples etc.
    if (!ISO6346.test(containerNo)) { air++; continue; }           // HAWB in the container column
    const shipKey = S(r["Ship Key"] ?? r.SHIPKEY);
    const line: ContainerLine = {
      po, supplierItem: S(r["PO Item"] ?? r.PURCHASEORDERITEM), qty: Number(r.Units ?? r.UNITS ?? 0) || 0,
      source: "century", sourceRef: shipKey, observedAt,
    };
    lines.push(line);

    const evRaw = S(r["Latest Event"] ?? r.LATEST_EVENT);
    const st: CenturyStatus = {
      event: evRaw || undefined, status: evRaw ? CENTURY_EVENT_STATUS[evRaw.toLowerCase()] ?? undefined : undefined,
      eventAt: date(r["Latest Event Date"] ?? r.LATEST_EVENT_DATE), vesselArrivedAt: date(r["Vessel Actual Arrival"] ?? r.VESSEL_ACTUAL_ARRIVAL),
      deliveredAt: date(r["Final Delivery Actual"] ?? r.FINAL_DELIVERY_ACTUAL), currentEta: date(r["Current ETA"] ?? r.CURRENT_ETA),
      forwarder: S(r["Carrier SCAC"] ?? r.SCAC) || undefined, updatedAt: observedAt,
    };
    if (st.vesselArrivedAt && (!st.status || st.status === "SAILING" || st.status === "LOADED" || st.status === "GATE_IN")) st.status = "ARRIVED";

    const f = containers.get(containerNo) ?? { containerNo, pos: [], lines: [], sources: ["century"], firstSeen: observedAt, lastSeen: observedAt };
    f.lines!.push(line);
    if (!f.pos!.includes(po)) f.pos!.push(po);
    f.mbl = S(r.MBL) || f.mbl;
    f.forwarder = st.forwarder ?? f.forwarder;
    f.vessel = S(r.Vessel ?? r.VESSEL) || f.vessel;
    f.shipMode = /^A/i.test(S(r["Ship Mode"] ?? r.SHIPMODE)) ? "A" : "O";
    f.etd = date(r["Departure Date"] ?? r.DEPARTURE_DATE) ?? f.etd;
    f.eta = st.currentEta ?? f.eta;
    // Outgate / Empty Returned = at (or past) our door. FINAL_DELIVERY_ACTUAL is unreliable (can precede arrival) — ignored.
    f.deliveredDate = st.status && DONE.has(st.status) ? st.eventAt : f.deliveredDate;
    f.shipKey = shipKey || f.shipKey;
    f.destCountry = "AU";
    f.century = st;
    containers.set(containerNo, f);
  }
  if (air) warnings.push(`Century: ${air} air rows (HAWB in container column) skipped`);
  if (nonPo) warnings.push(`Century: ${nonPo} rows without a 6-digit PO skipped`);
  return { lines, containers: [...containers.values()], warnings };
}
