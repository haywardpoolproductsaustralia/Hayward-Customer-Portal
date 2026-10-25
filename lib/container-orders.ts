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
import { getAllRecords } from '@/lib/containers/store';
import { trackOf, type ContainerTrack } from '@/lib/containers/summary';
import type { ContainerRecord } from '@/lib/containers/types';

export type { ContainerTrack };

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
  /** Live tracking for every box the container store ties to this PO (or to its SO via the forecast sheet):
   *  ShipsGo / Century / CHR status, best ETA, vessel, live-map link. Superset of `shipments` (which is CDS only). */
  tracking: ContainerTrack[];
  /** Going straight to a customer site, by any signal (PO address, forecast sheet, ShipsGo reference, discharge port). */
  direct: boolean;
  directWhy: string | null;
  /** Purchasing's forecast-sheet row for this order, when it has one. */
  forecast: ContainerTrack['forecast'] | null;
  /** Data the portal needs keyed in Arrow / ShipsGo so this order links itself without the forecast sheet. */
  needs: KeyingNeed[];
}

export type KeyingField = 'so' | 'poSoRef' | 'soAddress' | 'soFlag' | 'shipsgoRef';
export interface KeyingNeed {
  field: KeyingField;           // which cell on the page to highlight
  where: string;                // "Arrow PO 918400 · Despatch notes"
  what: string;                 // "Type: SO 446304"
  why: string;                  // one line
}

/** What is missing in Arrow / ShipsGo for this order to link and route itself. */
export function keyingNeeds(raw: ContainerOrderRaw, tracking: ContainerTrack[], direct: boolean, forecastSo?: string): KeyingNeed[] {
  const out: KeyingNeed[] = [];
  const soNo = raw.so?.orderNo ?? forecastSo ?? null;
  if (!raw.so && !forecastSo) {
    out.push({ field: 'so', where: `Arrow PO ${raw.po} · Despatch notes`, what: 'Type: SO <number>', why: 'No sales order could be matched to this PO, so there is no customer or delivery address to show.' });
  } else if (!raw.poSoRef || (soNo && raw.poSoRef !== soNo)) {
    out.push({ field: 'poSoRef', where: `Arrow PO ${raw.po} · Despatch notes`, what: `Type: SO ${soNo}`, why: raw.poSoRef ? `Despatch notes say SO ${raw.poSoRef}; the match is SO ${soNo}.` : `Linked only by ${raw.matchMethod === 'manual' ? 'a pin on this page' : raw.matchMethod === 'customerPo' ? 'the customer PO reference' : 'the forecast sheet'} — the SO number on the PO makes it permanent.` });
  }
  if (raw.so && direct && raw.so.address.source !== 'delivery') {
    out.push({ field: 'soAddress', where: `Arrow SO ${raw.so.orderNo} · Delivery address`, what: 'Key the customer site address', why: 'Direct container, but the SO carries only the account address — the driver needs the site.' });
  }
  if (raw.so && direct && !raw.so.isContainerFlag) {
    out.push({ field: 'soFlag', where: `Arrow SO ${raw.so.orderNo} · Order Descn 1`, what: 'Type: CONTAINER WUXI (or US / MEL)', why: 'Marks the SO as a direct container order so the sync picks it up without a manual link.' });
  }
  for (const t of tracking) {
    if (!t.sources.includes('shipsgo')) continue;
    const ref = (t.reference ?? '').replace(/\s/g, '');
    const mentions = ref.includes(raw.po) || (soNo && ref.includes(soNo));
    if (!mentions) out.push({ field: 'shipsgoRef', where: `ShipsGo · ${t.containerNo} · Reference`, what: `Add: PO ${raw.po}${soNo ? ` / SO ${soNo}` : ''}`, why: `Reference is “${(t.reference ?? '').slice(0, 50) || 'blank'}” — the box only links to this order through a document today.` });
  }
  return out;
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
  links: Record<string, string>,
  tracking: ContainerTrack[] = []
): ContainerOrder {
  const cds = shipmentsForPo(shipIdx.get(raw.po) ?? []);
  // Boxes the container store knows that the CDS file doesn't (US lane, ShipsGo-only, forecast sheet) join the list
  // so the page shows one set of containers whichever feed saw them first.
  const seen = new Set(cds.map((c) => c.container));
  const extra: ContainerShipment[] = tracking.filter((t) => !seen.has(t.containerNo)).map((t) => ({
    container: t.containerNo, vessel: t.vessel, etd: null, eta: t.eta, delivered: t.closed ? (t.eta ?? '') : null, destPort: t.pod, units: 0, items: 0,
  }));
  const shipments = [...cds, ...extra].sort((a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999'));
  const trackByNo = new Map(tracking.map((t) => [t.containerNo, t]));
  const isDone = (s: ContainerShipment) => Boolean(s.delivered) || Boolean(trackByNo.get(s.container)?.closed);
  const open = shipments.filter((s) => !isDone(s));
  const allDelivered = shipments.length > 0 && open.length === 0;

  let status: ContainerStatus;
  if (raw.poStatusFlag === 'X') status = 'cancelled';
  else if (raw.poStatusFlag === 'C' || (raw.poQty > 0 && raw.poOutstanding === 0)) status = 'completed';
  else if (allDelivered) status = 'arrived';
  else if (shipments.length > 0) status = 'in_transit';
  else status = 'awaiting_shipment';

  const direct = raw.shipTo === 'customer' || tracking.some((t) => t.direct);
  const directWhy = raw.shipTo === 'customer' ? 'PO delivery address is a customer site' : tracking.find((t) => t.direct)?.directWhy ?? null;
  const forecast = tracking.find((t) => t.forecast)?.forecast ?? null;
  const needs = raw.poStatusFlag === 'X' || raw.poStatusFlag === 'C' ? [] : keyingNeeds(raw, tracking, direct, forecast?.so);

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
    tracking,
    direct,
    directWhy,
    forecast,
    needs,
  };
}

/** Container-store records per PO — by the POs a box carries, and by the Arrow SO the forecast sheet names. */
function indexTracking(records: ContainerRecord[], orders: ContainerOrderRaw[]) {
  const directPos = new Set(orders.filter((o) => o.shipTo === 'customer').map((o) => o.po));
  const byPo = new Map<string, ContainerTrack[]>();
  const bySo = new Map<string, ContainerTrack[]>();
  for (const r of records) {
    const t = trackOf(r, directPos);
    for (const po of r.pos) (byPo.get(po) ?? byPo.set(po, []).get(po)!).push(t);
    if (r.forecast?.so) (bySo.get(r.forecast.so) ?? bySo.set(r.forecast.so, []).get(r.forecast.so)!).push(t);
  }
  return (o: ContainerOrderRaw): ContainerTrack[] => {
    const out = new Map<string, ContainerTrack>();
    for (const t of byPo.get(o.po) ?? []) out.set(t.containerNo, t);
    for (const t of bySo.get(o.so?.orderNo ?? '') ?? []) out.set(t.containerNo, t);
    return [...out.values()].sort((a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999'));
  };
}

export async function loadContainerLinks(): Promise<Record<string, string>> {
  const raw = await getJSON<Record<string, string>>(CONTAINER_LINKS_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export async function getContainerOrders(): Promise<ContainerOrdersPayload> {
  const [orders, unmatchedSos, meta, links, shipLines, shipMeta, records] = await Promise.all([
    getJSON<ContainerOrderRaw[]>(CONTAINER_ORDERS_KEY),
    getJSON<ContainerSo[]>(CONTAINER_SO_UNMATCHED_KEY),
    getJSON<ContainerMeta>(CONTAINER_META_KEY),
    loadContainerLinks(),
    getJSON<ShipmentLine[]>('recon:shipment_index'),
    getJSON<{ receivedAt?: string }>('recon:shipment_meta'),
    getAllRecords().catch(() => [] as ContainerRecord[]),
  ]);

  const shipIdx = new Map<string, ShipmentLine[]>();
  for (const l of Array.isArray(shipLines) ? shipLines : []) {
    const po = String(l.po ?? '').trim();
    if (!po) continue;
    const b = shipIdx.get(po);
    if (b) b.push(l);
    else shipIdx.set(po, [l]);
  }

  const rawOrders = Array.isArray(orders) ? orders : [];
  const trackingFor = indexTracking(records, rawOrders);
  const enriched = rawOrders.map((o) => enrichOrder(o, shipIdx, links, trackingFor(o)));

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
