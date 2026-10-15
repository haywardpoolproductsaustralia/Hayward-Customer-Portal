/* lib/container-orders.ts
   Direct container orders: Arrow sales order -> Hayward US/Wuxi purchase order
   -> CDS-Net container(s). The SO<->PO join is done on AZ-Grey by
   sync-container-orders.js (Redis container:orders); this module adds the
   shipment side from recon:shipment_index (same data the Purchasing page
   uses) and derives a headline status + ETA per PO.

   Redis keys read:
     container:orders        ContainerOrderRaw[]   <- sync-container-orders.js
     container:so_unmatched  ContainerSo[]         <- sync-container-orders.js
     container:meta          ContainerMeta         <- sync-container-orders.js
     container:links         Record<po, so>        <- /api/container-orders/link
     recon:shipment_index    ShipmentLine[]        <- CDS-Net upload / ingest
*/

import { getJSON } from '@/lib/redis';
import type { ShipmentLine } from '@/lib/recon/shipmentIngest';

export const CONTAINER_ORDERS_KEY = 'container:orders';
export const CONTAINER_SO_UNMATCHED_KEY = 'container:so_unmatched';
export const CONTAINER_META_KEY = 'container:meta';
export const CONTAINER_LINKS_KEY = 'container:links';

/* ---- shapes written by the sync ---- */

export interface ContainerAddress {
  source: 'delivery' | 'account' | 'none';
  lines: string[];
}

export interface ContainerSo {
  orderNo: string;
  customerCode: string;
  customerName: string;
  customerOrderNo: string | null;
  orderDate: string | null;
  deliveryDate: string | null;
  statusFlag: string;
  description: string | null;
  isContainerFlag: boolean;
  /** From ORDER_DESCN1 per the procedure: CONTAINER WUXI / US / MEL. */
  containerSource?: 'WUXI' | 'US' | 'MEL' | null;
  contactName: string | null;
  phone: string | null;
  address: ContainerAddress;
  deliveryNotes: string[];
  netValue: number | null;
  lines?: ContainerLine[];
}

export interface ContainerLine {
  sku: string;
  supplierSku: string | null;
  description: string | null;
  poQty: number | null;
  poReceived: number | null;
  poOutstanding: number | null;
  poLineEta: string | null;
  soQty: number | null;
  soShipped: number | null;
  soBackordered: number | null;
}

export interface ContainerOrderRaw {
  po: string;
  creditor: string;
  supplierName: string;
  poDate: string | null;
  poRequestedDate: string | null;
  poStatusFlag: string;
  /** DELIVERY_NOTE_1-3 on the PO = the delivery-address lines printed on it. */
  poDeliveryAddress: string[];
  /** Where the supplier ships the PO: Hayward (via Melbourne) or straight to a customer site. */
  shipTo: 'hayward' | 'customer' | 'unknown';
  /** Despatch Notes on the PO form (ORDER_DESCN1-3). */
  poDespatchNotes?: string[];
  /** The SO number purchasing wrote on the Despatch Notes ("SO 446304"), if any. */
  poSoRef?: string | null;
  customerPoRef: string | null;
  poNetValue: number | null;
  poQty: number;
  poReceived: number;
  poOutstanding: number;
  poLineCount: number;
  so: ContainerSo | null;
  matchMethod: 'customerPo' | 'soNumber' | 'manual' | null;
  ambiguousCandidates: number;
  lines: ContainerLine[];
}

export interface ContainerMeta {
  generatedAt?: string;
  posScanned?: number;
  pos?: number;
  matched?: number;
  unmatchedPos?: number;
  unmatchedSos?: number;
  manualLinks?: number;
  lastError?: string;
  lastErrorAt?: string;
}

/* ---- shapes served to the page ---- */

export interface ContainerShipment {
  container: string;
  vessel: string | null;
  etd: string | null;
  eta: string | null;
  delivered: string | null;
  destPort: string | null;
  units: number;
  items: number;
}

export type ContainerStatus =
  | 'awaiting_shipment' // PO raised, nothing in the CDS-Net file yet
  | 'in_transit'        // at least one container on the water
  | 'arrived'           // every container delivered per CDS-Net, PO still open
  | 'completed'         // PO closed in Arrow / fully received
  | 'cancelled';

export interface ContainerOrder extends ContainerOrderRaw {
  shipments: ContainerShipment[];
  status: ContainerStatus;
  /** Best current ETA: latest undelivered container ETA, else the PO's requested date. */
  eta: string | null;
  etaSource: 'container' | 'po' | 'none';
  deliveredDate: string | null;
  /** Days the container ETA sits past the PO's requested date (null if unknown). */
  daysLate: number | null;
  /** True when the SO was linked by hand from the page. */
  pinned: boolean;
}

export interface ContainerOrdersPayload {
  orders: ContainerOrder[];
  unmatchedSos: ContainerSo[];
  meta: ContainerMeta;
  shipmentReceivedAt: string | null;
  links: Record<string, string>;
}

/* ---- helpers ---- */

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);

/** Group the CDS-Net lines for one PO into one entry per container. */
export function shipmentsForPo(lines: ShipmentLine[]): ContainerShipment[] {
  const byContainer = new Map<string, ContainerShipment>();
  for (const l of lines) {
    const key = l.container ?? '(no container)';
    const cur = byContainer.get(key);
    if (cur) {
      cur.units += l.units ?? 0;
      cur.items += 1;
      // keep the latest ETA / earliest ETD across the container's lines
      if (l.eta && (!cur.eta || l.eta > cur.eta)) cur.eta = l.eta;
      if (l.etd && (!cur.etd || l.etd < cur.etd)) cur.etd = l.etd;
      if (!cur.delivered && l.delivered) cur.delivered = l.delivered;
      if (!cur.vessel && l.vessel) cur.vessel = l.vessel;
    } else {
      byContainer.set(key, {
        container: key,
        vessel: l.vessel,
        etd: l.etd,
        eta: l.eta,
        delivered: l.delivered,
        destPort: l.destPort,
        units: l.units ?? 0,
        items: 1,
      });
    }
  }
  return [...byContainer.values()].sort((a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999'));
}

export function enrichOrder(
  raw: ContainerOrderRaw,
  shipIdx: Map<string, ShipmentLine[]>,
  links: Record<string, string>
): ContainerOrder {
  const shipments = shipmentsForPo(shipIdx.get(raw.po) ?? []);
  const open = shipments.filter((s) => !s.delivered);
  const allDelivered = shipments.length > 0 && open.length === 0;

  let status: ContainerStatus;
  if (raw.poStatusFlag === 'X') status = 'cancelled';
  else if (raw.poStatusFlag === 'C' || (raw.poQty > 0 && raw.poOutstanding === 0)) status = 'completed';
  else if (allDelivered) status = 'arrived';
  else if (shipments.length > 0) status = 'in_transit';
  else status = 'awaiting_shipment';

  // The order is "there" when its last container lands, so the headline ETA is
  // the latest undelivered container; before anything ships we fall back to
  // the date purchasing asked for on the PO.
  const containerEta = open.reduce<string | null>((m, s) => (s.eta && (!m || s.eta > m) ? s.eta : m), null);
  const eta = containerEta ?? raw.poRequestedDate ?? null;
  const etaSource: ContainerOrder['etaSource'] = containerEta ? 'container' : raw.poRequestedDate ? 'po' : 'none';
  const deliveredDate = allDelivered
    ? shipments.reduce<string | null>((m, s) => (s.delivered && (!m || s.delivered > m) ? s.delivered : m), null)
    : null;
  const daysLate =
    containerEta && raw.poRequestedDate ? daysBetween(containerEta, raw.poRequestedDate) : null;

  return {
    ...raw,
    shipments,
    status,
    eta,
    etaSource,
    deliveredDate,
    daysLate,
    pinned: Boolean(links[raw.po]),
  };
}

export async function loadContainerLinks(): Promise<Record<string, string>> {
  const raw = await getJSON<Record<string, string>>(CONTAINER_LINKS_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export async function getContainerOrders(): Promise<ContainerOrdersPayload> {
  const [orders, unmatchedSos, meta, links, shipLines, shipMeta] = await Promise.all([
    getJSON<ContainerOrderRaw[]>(CONTAINER_ORDERS_KEY),
    getJSON<ContainerSo[]>(CONTAINER_SO_UNMATCHED_KEY),
    getJSON<ContainerMeta>(CONTAINER_META_KEY),
    loadContainerLinks(),
    getJSON<ShipmentLine[]>('recon:shipment_index'),
    getJSON<{ receivedAt?: string }>('recon:shipment_meta'),
  ]);

  const shipIdx = new Map<string, ShipmentLine[]>();
  for (const l of Array.isArray(shipLines) ? shipLines : []) {
    const po = String(l.po ?? '').trim();
    if (!po) continue;
    const b = shipIdx.get(po);
    if (b) b.push(l);
    else shipIdx.set(po, [l]);
  }

  const enriched = (Array.isArray(orders) ? orders : []).map((o) => enrichOrder(o, shipIdx, links));

  // Newest PO first; unlinked ones sort with the rest by date rather than
  // being pushed to the bottom, so a fresh PO missing its SO is noticed.
  enriched.sort((a, b) => (b.poDate ?? '').localeCompare(a.poDate ?? '') || b.po.localeCompare(a.po));

  return {
    orders: enriched,
    unmatchedSos: Array.isArray(unmatchedSos) ? unmatchedSos : [],
    meta: meta ?? {},
    shipmentReceivedAt: shipMeta?.receivedAt ?? null,
    links,
  };
}
