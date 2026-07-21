/* lib/recon/shipmentIngest.ts
   Parser for the CDS-Net "Shipment Activity by Container" workbook.

   No mailbox code here: a Power Automate flow watches jtatapudi@hayward.com for
   NoReply@cds-net.com emails and POSTs the attachment to
   /api/shipment-inbox/ingest, which calls parseShipmentWorkbook() and stores
   the result in Redis (recon:shipment_index). This file is just the parse +
   AU/NZ filter, and the helpers reconcile.ts uses to look shipments up.
*/

import * as XLSX from "xlsx";

/* AU/NZ destination ports. Dest. Port Name is the reliable signal — the file's
   "Destination Country" column is actually country of ORIGIN. */
const AUNZ_PORTS = new Set(
  [
    "melbourne", "sydney", "brisbane", "darwin", "adelaide", "perth", "fremantle",
    "port botany", "townsville", "fisherman islands",
    "auckland", "tauranga", "lyttelton", "wellington", "napier",
    "port chalmers", "nelson", "christchurch", "otago",
  ]
);

export interface ShipmentLine {
  po: string;
  item: string;
  container: string | null;
  vessel: string | null;
  etd: string | null;       // ISO yyyy-mm-dd
  eta: string | null;
  delivered: string | null; // Delivered, else Actual Delivered Date
  units: number | null;
  carrier: string | null;
  origin: string | null;
  destPort: string | null;
  location: string | null;
  shipMode: string | null;
}

/* Index for reconcile: `${po}::${item}` -> all matching shipment lines
   (a line can appear on several containers; the engine picks the best one). */
export type ShipmentIndex = Map<string, ShipmentLine[]>;
export const shipmentKey = (po: string, item: string) => `${po}::${item}`;

export function buildShipmentIndex(lines: ShipmentLine[]): ShipmentIndex {
  const idx: ShipmentIndex = new Map();
  for (const l of lines) {
    const k = shipmentKey(l.po, l.item);
    const bucket = idx.get(k);
    if (bucket) bucket.push(l);
    else idx.set(k, [l]);
  }
  return idx;
}

function toISO(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && (XLSX as any).SSF) {
    const d = (XLSX as any).SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const clean = (v: unknown): string | null => (v == null ? null : String(v).trim() || null);
const isSixDigitPO = (s: string) => /^[0-9]{6}$/.test(s);

/** Parse the workbook buffer into a flat array of AU/NZ shipment lines. */
export function parseShipmentWorkbook(buf: ArrayBuffer | Uint8Array): ShipmentLine[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  const headerIdx = rows.findIndex((r) => Array.isArray(r) && r.includes("PO #"));
  if (headerIdx < 0) throw new Error('Shipment file: no "PO #" header row found.');
  const header = rows[headerIdx] as string[];
  const col = (name: string) => header.indexOf(name);

  const c = {
    po: col("PO #"), item: col("Item #"), container: col("Container #"),
    vessel: col("Vessel"), etd: col("ETD"), eta: col("ETA"),
    delivered: col("Delivered"), actualDelivered: col("Actual Delivered Date"),
    units: col("Units"), carrier: col("Carrier Name"),
    origin: col("Origin Port Name"), destPort: col("Dest. Port Name"),
    location: col("Location Name"), shipMode: col("Ship Mode"),
  };

  const out: ShipmentLine[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length === 0) continue;

    const po = clean(r[c.po]);
    if (!po || !isSixDigitPO(po)) continue;                 // Arrow-shaped POs only

    const destPort = clean(r[c.destPort]);
    if (!destPort || !AUNZ_PORTS.has(destPort.toLowerCase())) continue; // AU/NZ only

    const item = clean(r[c.item]);
    if (!item) continue;

    out.push({
      po, item,
      container: clean(r[c.container]),
      vessel: clean(r[c.vessel]),
      etd: toISO(r[c.etd]),
      eta: toISO(r[c.eta]),
      delivered: toISO(r[c.delivered]) ?? toISO(r[c.actualDelivered]),
      units: r[c.units] != null && r[c.units] !== "" ? Number(r[c.units]) : null,
      carrier: clean(r[c.carrier]),
      origin: clean(r[c.origin]),
      destPort,
      location: clean(r[c.location]),
      shipMode: clean(r[c.shipMode]),
    });
  }
  return out;
}
