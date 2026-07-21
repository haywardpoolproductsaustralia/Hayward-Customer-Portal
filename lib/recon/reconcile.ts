/* ============================================================================
   reconcile.ts   —   three-way PO reconciliation engine
   ----------------------------------------------------------------------------
   Joins:  Arrow open PO lines  (source of truth, what we ordered)
        x  AS400 supplier orders (what the supplier entered, PO+SKU grain)
        x  Shipment index        (AU/NZ containers from the CDS-Net file)

   Emits one ReconLine per Arrow line with a headline status, granular flags,
   and a derived customer ETA. This is the server-side twin of the logic in
   the portal page, so the page and any scheduled job stay in agreement.

   Join model (confirmed against real data):
     PO level : Arrow PO_NUMBER = AS400 PO_NUMBER = shipment PO#
     Item level: Arrow SUPPLIER_SKU = AS400 AS400_CODE = shipment Item#
   ========================================================================== */

import type { ShipmentIndex, ShipmentLine } from "./shipmentIngest";
import { shipmentKey } from "./shipmentIngest";

/* ---- input shapes (map your SQL result columns onto these) ---- */
export interface ArrowLine {
  po: string;              // PO_NUMBER
  line: number;            // LINE_NO
  arrowStock: string;      // ARROW_STOCK_CODE
  supplierSku: string;     // SUPPLIER_SKU  (bridge key)
  description: string | null;
  creditor: string | null;
  qtyOrdered: number;
  qtyReceived: number;   // net across Arrow's partial-receipt splits
  qtyOutstanding: number;
  requestedDate: string | null; // what WE asked for (line, else header)
}

export interface As400Row {
  poNumber: string;
  as400Code: string;
  orderedQty: number;
  shippedQty: number;
  promiseDate: string | null;
  anyCancelled: boolean;
  usSalesOrder: string | null;
  location: string | null;
}

export type As400Index = Map<string, As400Row>; // key: `${po}\u0000${sku}`
export const as400Key = (po: string, sku: string) => `${po}\u0000${sku}`;

export function buildAs400Index(rows: As400Row[]): As400Index {
  const m: As400Index = new Map();
  for (const r of rows) m.set(as400Key(r.poNumber, r.as400Code), r);
  return m;
}

/* ---- output shapes ---- */
export type Head =
  | "matched" | "delivered" | "qty_mismatch"
  | "missing_at_supplier" | "cancelled" | "in_transit" | "awaiting_shipment";

export type EtaKind = "delivered" | "container_eta" | "supplier_promise" | "none";

export interface ReconFlag { kind: string; text: string; severity: "error" | "warn" | "info"; }

export interface ReconLine {
  po: string;
  line: number;
  arrowStock: string;
  supplierSku: string;
  description: string | null;
  qtyOrdered: number;

  as400: As400Row | null;
  shipment: ShipmentLine | null;
  shipmentCount: number;

  head: Head;
  flags: ReconFlag[];
  eta: string | null;
  etaKind: EtaKind;
  daysLate: number | null; // container/actual vs. what we requested; null if unknown
}

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);

/** Pick the best container for a line: prefer delivered, else earliest ETA. */
function pickContainer(cands: ShipmentLine[]): ShipmentLine {
  return [...cands].sort((x, y) => {
    const xd = x.delivered ? 0 : 1, yd = y.delivered ? 0 : 1;
    if (xd !== yd) return xd - yd;
    return (x.eta ?? "9999-99-99").localeCompare(y.eta ?? "9999-99-99");
  })[0];
}

export function reconcileLine(
  a: ArrowLine,
  as400Idx: As400Index,
  shipIdx: ShipmentIndex
): ReconLine {
  const as400 = as400Idx.get(as400Key(a.po, a.supplierSku)) ?? null;
  const cands = shipIdx.get(shipmentKey(a.po, a.supplierSku)) ?? [];
  const shipment = cands.length ? pickContainer(cands) : null;

  const flags: ReconFlag[] = [];

  // --- supplier-entry checks ---
  if (!as400) {
    flags.push({ kind: "missing", text: "Not entered by supplier", severity: "error" });
  } else {
    if (as400.anyCancelled && as400.orderedQty === 0) {
      flags.push({ kind: "cancelled", text: "Cancelled in AS400", severity: "error" });
    }
    if (Math.round(a.qtyOrdered) !== Math.round(as400.orderedQty)) {
      flags.push({
        kind: "qty",
        text: `Qty mismatch \u00b7 we ordered ${a.qtyOrdered}, supplier entered ${as400.orderedQty}`,
        severity: "warn",
      });
    }
  }

  // --- Arrow receipt status (from netted split rows) ---
  if (a.qtyReceived > 0 && a.qtyOutstanding > 0) {
    flags.push({
      kind: "partial",
      text: `Partially received \u00b7 ${a.qtyReceived} of ${a.qtyOrdered} in, ${a.qtyOutstanding} still due`,
      severity: "info",
    });
  }

  // --- shipment checks ---
  if (as400 && !shipment && !(as400.anyCancelled && as400.orderedQty === 0)) {
    flags.push({ kind: "noship", text: "No AU/NZ container matched yet", severity: "info" });
  }

  // --- derived ETA (precedence: delivered > container ETA > supplier promise) ---
  let eta: string | null = null, etaKind: EtaKind = "none";
  if (shipment?.delivered) { eta = shipment.delivered; etaKind = "delivered"; }
  else if (shipment?.eta) { eta = shipment.eta; etaKind = "container_eta"; }
  else if (as400?.promiseDate) { eta = as400.promiseDate; etaKind = "supplier_promise"; }

  const daysLate =
    a.requestedDate && eta ? daysBetween(eta, a.requestedDate) : null;

  // --- headline (worst-first) ---
  let head: Head;
  if (!as400) head = "missing_at_supplier";
  else if (as400.anyCancelled && as400.orderedQty === 0) head = "cancelled";
  else if (Math.round(a.qtyOrdered) !== Math.round(as400.orderedQty)) head = "qty_mismatch";
  else if (shipment?.delivered) head = "delivered";
  else if (shipment?.eta) head = "in_transit";
  else if (!shipment) head = "awaiting_shipment";
  else head = "matched";

  return {
    po: a.po, line: a.line, arrowStock: a.arrowStock, supplierSku: a.supplierSku,
    description: a.description, qtyOrdered: a.qtyOrdered,
    as400, shipment, shipmentCount: cands.length,
    head, flags, eta, etaKind, daysLate,
  };
}

export function reconcile(
  arrow: ArrowLine[],
  as400Idx: As400Index,
  shipIdx: ShipmentIndex
): ReconLine[] {
  return arrow.map((a) => reconcileLine(a, as400Idx, shipIdx));
}

/** Roll-up for the summary cards. */
export function summarize(lines: ReconLine[]) {
  const s = { total: lines.length, exceptions: 0, inTransit: 0, delivered: 0, awaiting: 0, late: 0 };
  for (const l of lines) {
    if (l.head === "missing_at_supplier" || l.head === "cancelled" || l.head === "qty_mismatch") s.exceptions++;
    if (l.head === "in_transit") s.inTransit++;
    if (l.head === "delivered") s.delivered++;
    if (l.head === "awaiting_shipment") s.awaiting++;
    if (l.daysLate != null && l.daysLate > 0) s.late++;
  }
  return s;
}
