// lib/containers/parse-cds.ts
// Container-level view of the CDS-Net "Shipment Activity by Container" xlsx (NoReply@cds-net.com, daily).
// lib/recon/shipmentIngest.ts still produces the per-line ShipLine[] the page has always used; this
// parser adds what that one drops — MBL, HBL, forwarder, voyage, ship key, seal — keyed by container,
// so the container store can register MBLs with ShipsGo and deep-link to Century.
//
// Filter: AU/NZ by Dest. Port Name OR Destination Country (the file is Hayward-global, ~9.5k rows).

import * as XLSX from "xlsx";
import type { ContainerLine, ContainerRecord, ParseResult } from "./types";
import { ISO6346 } from "./types";

const AUNZ_PORTS = new Set([
  "melbourne", "sydney", "brisbane", "darwin", "adelaide", "perth", "fremantle", "port botany", "townsville", "fisherman islands",
  "auckland", "tauranga", "lyttelton", "wellington", "napier", "port chalmers", "nelson", "christchurch", "otago",
]);

function iso(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    const d = (XLSX as any).SSF?.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return undefined;
}
const S = (v: unknown) => (v == null ? "" : String(v).trim());

export function parseCdsContainers(buf: Buffer | Uint8Array, observedAt: string): ParseResult {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const hIdx = rows.findIndex((r) => Array.isArray(r) && r.includes("PO #"));
  if (hIdx < 0) return { lines: [], containers: [], warnings: ['CDS: no "PO #" header row'] };
  const hdr = (rows[hIdx] as unknown[]).map((h) => S(h));
  const col = (name: string) => hdr.indexOf(name);
  const C = {
    shipKey: col("CDS Ship Key #"), mbl: col("MBL #"), hbl: col("HBL #"), carrier: col("Carrier Name"), vendor: col("Vendor Name"),
    po: col("PO #"), item: col("Item #"), desc: col("Item Description"), units: col("Units"), origin: col("Origin Port Name"),
    mode: col("Ship Mode"), etd: col("ETD"), vessel: col("Vessel"), voyage: col("Voyage"), dest: col("Dest. Port Name"),
    eta: col("ETA"), country: col("Destination Country"), delivered: col("Delivered"), container: col("Container #"),
    size: col("Container Size"), unitCost: col("Unit Cost"), actualDelivered: col("Actual Delivered Date"),
  };

  const lines: ContainerLine[] = [];
  const containers = new Map<string, Partial<ContainerRecord>>();
  const warnings: string[] = [];
  let hblShaped = 0;

  for (const r of rows.slice(hIdx + 1)) {
    if (!Array.isArray(r) || !r[C.po]) continue;
    const destPort = S(r[C.dest]);
    const country = S(r[C.country]);
    if (!AUNZ_PORTS.has(destPort.toLowerCase()) && country !== "AU" && country !== "NZ") continue;
    const po = S(r[C.po]);
    if (!/^\d{6}$/.test(po)) continue;

    const containerNo = S(r[C.container]).toUpperCase();
    if (!containerNo) continue;                         // booked, not yet containerised — ShipLine[] covers that
    if (!ISO6346.test(containerNo)) { hblShaped++; continue; } // air HAWB (e.g. 554171424PVG) in the container column

    const line: ContainerLine = {
      po, supplierItem: S(r[C.item]), qty: Number(r[C.units] ?? 0) || 0, source: "cds", sourceRef: S(r[C.shipKey]),
      description: S(r[C.desc]) || undefined, unitCost: r[C.unitCost] != null && r[C.unitCost] !== "" ? Number(r[C.unitCost]) : undefined,
      observedAt,
    };
    lines.push(line);

    // Lines ride on the container entry (a CDS file has many containers; the store attributes by entry).
    const f = containers.get(containerNo) ?? { containerNo, pos: [], lines: [], sources: ["cds"], firstSeen: observedAt, lastSeen: observedAt };
    f.lines!.push(line);
    if (!f.pos!.includes(po)) f.pos!.push(po);
    f.mbl = S(r[C.mbl]) || f.mbl; f.hbl = S(r[C.hbl]) || f.hbl;
    f.forwarder = S(r[C.carrier]) || f.forwarder; f.vendor = S(r[C.vendor]) || f.vendor;
    f.originPort = S(r[C.origin]) || f.originPort; f.destPort = destPort || f.destPort;
    f.shipMode = (S(r[C.mode]) === "A" ? "A" : S(r[C.mode]) === "O" ? "O" : f.shipMode);
    f.vessel = S(r[C.vessel]) || f.vessel; f.voyage = S(r[C.voyage]) || f.voyage;
    f.etd = iso(r[C.etd]) ?? f.etd; f.eta = iso(r[C.eta]) ?? f.eta;
    f.deliveredDate = iso(r[C.actualDelivered]) ?? iso(r[C.delivered]) ?? f.deliveredDate;
    f.size = S(r[C.size]) || f.size; f.shipKey = S(r[C.shipKey]) || f.shipKey;
    containers.set(containerNo, f);
  }
  if (hblShaped) warnings.push(`CDS: ${hblShaped} AU/NZ rows with a non-container value in "Container #" (air) skipped`);
  // Top-level `lines` is informational (counts); the store takes lines from each container entry.
  return { lines, containers: [...containers.values()], warnings };
}
