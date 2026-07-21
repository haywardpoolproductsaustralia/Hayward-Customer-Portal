/* ============================================================================
   shipmentIngest.ts   —   CDS-Net "Shipment Activity by Container" ingest
   ----------------------------------------------------------------------------
   Finds the latest email from NoReply@cds-net.com whose attachment is named
   "Shipment Activity by Container", downloads the .xlsx, parses it, and
   returns AU/NZ-bound shipment rows keyed by  PO# + Item#.

   Deps already available to the portal: SheetJS ("xlsx"), Microsoft Graph.
   Auth: app-only Graph token (client credentials) with Mail.Read on the
   shared/target mailbox. Pass the mailbox address + a token getter in.

   The header row in this workbook is the 3rd row (title + company sit above
   it), so we locate it by looking for the "PO #" cell rather than assuming.
   ========================================================================== */

import * as XLSX from "xlsx";

/* ---- AU/NZ destination ports. Dest. Port Name is the reliable signal;
        "Destination Country" in this file is actually country of ORIGIN. ---- */
const AUNZ_PORTS = new Set(
  [
    // Australia
    "melbourne", "sydney", "brisbane", "darwin", "adelaide", "perth",
    "fremantle", "port botany", "townsville", "fisherman islands",
    // New Zealand
    "auckland", "tauranga", "lyttelton", "wellington", "napier",
    "port chalmers", "nelson", "christchurch", "otago",
  ].map((s) => s.toLowerCase())
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

/* Map of `${po}\u0000${item}` -> all matching shipment lines (a line can appear
   on several containers). Reconciliation picks the best one. */
export type ShipmentIndex = Map<string, ShipmentLine[]>;

const keyOf = (po: string, item: string) => `${po}\u0000${item}`;

function toISO(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // SheetJS may hand back a serial number or a string
  if (typeof v === "number") {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const clean = (v: unknown): string | null =>
  v == null ? null : String(v).trim() || null;

const isSixDigitPO = (s: string) => /^[0-9]{6}$/.test(s);

/** Parse an already-downloaded workbook buffer into an AU/NZ shipment index. */
export function parseShipmentWorkbook(buf: ArrayBuffer | Uint8Array): ShipmentIndex {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  // locate header row by finding "PO #"
  const headerIdx = rows.findIndex((r) => Array.isArray(r) && r.includes("PO #"));
  if (headerIdx < 0) throw new Error('Could not find header row (no "PO #" column).');
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

  const index: ShipmentIndex = new Map();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length === 0) continue;

    const po = clean(r[c.po]);
    if (!po || !isSixDigitPO(po)) continue;               // Arrow-shaped POs only

    const destPort = clean(r[c.destPort]);
    if (!destPort || !AUNZ_PORTS.has(destPort.toLowerCase())) continue; // AU/NZ only

    const item = clean(r[c.item]);
    if (!item) continue;

    const line: ShipmentLine = {
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
    };

    const k = keyOf(po, item);
    const bucket = index.get(k);
    if (bucket) bucket.push(line);
    else index.set(k, [line]);
  }

  return index;
}

/* ----------------------------------------------------------------------------
   Mailbox fetch via Microsoft Graph (app-only).
   getToken() should return a valid bearer token for https://graph.microsoft.com
   scoped Mail.Read on `mailbox`.
   ---------------------------------------------------------------------------- */
const GRAPH = "https://graph.microsoft.com/v1.0";

async function graph<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Fetch + parse the most recent CDS-Net shipment workbook for a mailbox. */
export async function fetchLatestShipmentIndex(opts: {
  mailbox: string;
  getToken: () => Promise<string>;
  senderFilter?: string;         // default NoReply@cds-net.com
  attachmentNameContains?: string; // default "Shipment Activity by Container"
}): Promise<{ index: ShipmentIndex; receivedAt: string; subject: string }> {
  const token = await opts.getToken();
  const sender = opts.senderFilter ?? "NoReply@cds-net.com";
  const attName = opts.attachmentNameContains ?? "Shipment Activity by Container";

  // newest messages from the sender that carry attachments
  const filter = encodeURIComponent(
    `from/emailAddress/address eq '${sender}' and hasAttachments eq true`
  );
  const listUrl =
    `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages` +
    `?$filter=${filter}&$orderby=receivedDateTime desc&$top=10` +
    `&$select=id,subject,receivedDateTime`;

  const list = await graph<{ value: Array<{ id: string; subject: string; receivedDateTime: string }> }>(
    listUrl, token
  );

  for (const msg of list.value) {
    const attsUrl =
      `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages/${msg.id}` +
      `/attachments?$select=id,name,contentType,size`;
    const atts = await graph<{ value: Array<{ id: string; name: string }> }>(attsUrl, token);
    const match = atts.value.find((a) =>
      a.name?.toLowerCase().includes(attName.toLowerCase())
    );
    if (!match) continue;

    // download the attachment bytes
    const rawUrl =
      `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages/${msg.id}` +
      `/attachments/${match.id}/$value`;
    const res = await fetch(rawUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Attachment download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    return {
      index: parseShipmentWorkbook(buf),
      receivedAt: msg.receivedDateTime,
      subject: msg.subject,
    };
  }

  throw new Error(
    `No recent email from ${sender} with a "${attName}" attachment was found.`
  );
}

export { keyOf as shipmentKey };
