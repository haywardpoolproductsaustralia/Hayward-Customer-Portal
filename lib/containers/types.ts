// lib/containers/types.ts
// Unified shapes for inbound container data, regardless of which document it came from.
//
// Sources (in priority order when facts disagree — see store.ts):
//   shipsgo           live tracking (ShipsGo Ocean API v2) — status, ETA, vessel, movements
//   cds               CDS-Net "Shipment Activity by Container" xlsx (NoReply@cds-net.com) — Wuxi containers, MBL, voyage
//   wuxi-packing-slip robot@hayward.com "Hayward Shipment for PO: 9xxxxx" → R#######.PDF
//   us-invoice        sbateman@hayward.com "Inv#: 00134xxxxx  PO: 9xxxxx" → MFX-000x_INVOICE_FT.PDF
// The two PDFs are the ONLY early signal for US-origin containers, which CDS stopped carrying in Feb 2026.

export type ContainerSource = "shipsgo" | "century" | "chr" | "cds" | "wuxi-packing-slip" | "us-invoice";

/** Latest state from the C.H. Robinson Navisphere shipment report (shipment-level; the only feed for the US lane). */
export interface ChrStatus {
  shipmentNo: string;
  reference?: string;         // CHR "Customer Reference Number" — POs for Wuxi, a date/week for US bookings
  statusRaw: string;          // "Depart Port", "Port Cmplt", "Unloading", "Booked Complete"…
  status?: string;            // mapped to the ShipsGo container-status vocabulary
  etd?: string; atd?: string; eta?: string; ata?: string;
  pickedUpAt?: string;        // "Pickup From Departed" — close to the US invoice ship date
  deliverEta?: string; deliveredAt?: string;
  carrier?: string; hbl?: string;
  usOrigin: boolean;
  updatedAt: string;
}

/** Latest tracking state from the Century/VIZIV per-line CSV (forwarder events, current ETA). */
export interface CenturyStatus {
  event?: string;             // as printed: "Vessel Departed", "Outgate", "Unloaded from Vessel", "Empty Returned"…
  status?: string;            // mapped to the ShipsGo container-status vocabulary (SAILING, GATE_OUT…)
  eventAt?: string;
  vesselArrivedAt?: string;
  deliveredAt?: string;       // FINAL_DELIVERY_ACTUAL — unreliable, informational only
  currentEta?: string;
  forwarder?: string;         // CHSL / FLXT / EXDO
  updatedAt: string;
}

/** One PO line (PO + supplier item) asserted to be inside a container by one source. */
export interface ContainerLine {
  po: string;                 // Arrow PORMAST.ORDER_NUMBER, 6 digits
  supplierItem: string;       // as printed by the source (may contain spaces — match on normKey())
  qty: number;                // units in THIS container for this line
  source: ContainerSource;
  sourceRef: string;          // invoice no / packing-slip order no / CDS ship key
  description?: string;
  unitCost?: number;          // USD where the source has it
  observedAt: string;         // ISO timestamp of the email/report
}

/** One ShipsGo movement (ACT = happened, EST = planned). */
export interface Movement {
  event: string;              // EMSH | GTIN | LOAD | DEPA | ARRV | DISC | GTOT | EMRT
  status: "ACT" | "EST";
  location?: string;
  locationCode?: string;
  vessel?: string;
  voyage?: string;
  timestamp: string;          // "YYYY-MM-DD HH:MM:SS" local port time, per ShipsGo
}

/** What ShipsGo last told us about this container. */
export interface LiveStatus {
  shipmentId: number;
  reference?: string;
  shipmentStatus?: string;    // NEW | INPROGRESS | BOOKED | LOADED | SAILING | ARRIVED | DISCHARGED | UNTRACKED
  containerStatus?: string;   // EMPTY_SHIPPER | GATE_IN | LOADED | SAILING | ARRIVED | DISCHARGED | GATE_OUT | EMPTY_RETURN | UNKNOWN
  carrier?: string;
  carrierScac?: string;
  pol?: string;
  pod?: string;
  etd?: string;               // ISO date
  eta?: string;               // current ETA at POD (ISO date)
  etaInitial?: string;        // first ETA the carrier declared — difference = slip
  etaPredicted?: string;      // ShipsGo's own ETA-prediction model (null once the voyage is done)
  mapUrl?: string;            // public live-map link: https://map.shipsgo.com/ocean/shipments/{id}?token=…
  previousEta?: string;       // last different ETA WE saw (drives the "was dd/mm" marker)
  etaChangedAt?: string;
  vessel?: string;
  voyage?: string;
  transitPercentage?: number;
  movements: Movement[];
  checkedAt?: string;         // ShipsGo's own last-check time
  sourceUpdatedAt?: string;   // ShipsGo updated_at — unchanged means we can skip the detail call
  updatedAt: string;          // when we last pulled it
}

/** Everything we know about one container, from every source, in one Redis key. */
export interface ContainerRecord {
  containerNo: string;        // ISO 6346, e.g. ONEU9571624
  pos: string[];              // every Arrow PO with goods in this box (from lines, or ShipsGo reference)
  lines: ContainerLine[];
  sources: ContainerSource[];
  firstSeen: string;
  lastSeen: string;
  // facts — CDS has the voyage data; the PDFs only know ship date / mode / origin
  mbl?: string;
  hbl?: string;
  forwarder?: string;         // CDS "Carrier Name" is the forwarder (EFL, Expeditors…), not the line
  vendor?: string;
  originPort?: string;
  destPort?: string;
  shipMode?: "O" | "A";
  vessel?: string;
  voyage?: string;
  etd?: string;
  eta?: string;               // document ETA (CDS)
  deliveredDate?: string;     // CDS Delivered / Actual Delivered Date
  size?: string;
  shipKey?: string;           // CDS / Century ship key → centuryvms deep link
  destCountry?: string;
  century?: CenturyStatus;    // latest Century event — status when ShipsGo doesn't track the box
  chr?: ChrStatus;            // C.H. Robinson shipment state (US lane)
  invoiceNos?: string[];
  packingSlipNos?: string[];
  live?: LiveStatus;
  registration?: { shipmentId: number; by: "container_number" | "booking_number" | "manual"; number: string; at: string };
}

export interface ParseResult {
  lines: ContainerLine[];
  containers: Partial<ContainerRecord>[]; // containerNo + whatever facts the source has
  warnings: string[];
}

/** Matching key used by the purchasing page: uppercase, A-Z0-9 only ("SP 2800WA5AU" → "SP2800WA5AU"). */
export const normKey = (v: string | null | undefined) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const lineKey = (po: string, item: string) => `${po}|${normKey(item)}`;

export const ISO6346 = /^[A-Z]{4}\d{7}$/;

/** ISO 6346 check-digit validation — catches OCR/typo errors before we spend a ShipsGo credit. */
export function isValidContainerNo(no: string): boolean {
  const m = /^([A-Z]{4})(\d{6})(\d)$/.exec(no);
  if (!m) return false;
  const TABLE = "0123456789A?BCDEFGHIJK?LMNOPQRSTU?VWXYZ"; // letter values skip multiples of 11
  const chars = (m[1] + m[2]).split("");
  const sum = chars.reduce((acc, ch, i) => acc + TABLE.indexOf(ch) * 2 ** i, 0);
  return (sum % 11) % 10 === Number(m[3]);
}
