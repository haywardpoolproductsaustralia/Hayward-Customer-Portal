// lib/containers/parse-supplier-docs.ts
// Parsers for the two supplier PDFs that land in Dimi's mailbox the day the box is loaded — weeks
// before CDS knows about it (and CDS never sees US-origin boxes at all since Feb 2026):
//
//   1. Hayward Industries, Inc. invoice  — sbateman@hayward.com, subject "Inv#: 0013455741  PO: 918498",
//      attachment MFX-000x_INVOICE_FT.PDF. One invoice = one PO. Prints "Container#:  ONEU9571624".
//      Issued from Charlotte for BOTH US- and Wuxi-shipped goods (F.O.B. line says which).
//   2. Hayward Wuxi packing slip         — robot@hayward.com, subject "Hayward Shipment for PO: 918498",
//      attachment R#######.PDF. "Qty This Shipment" is what is actually in the container.
//
// Verified against real documents on 21 Oct 2026 (MFX-0001_INVOICE_FT.PDF for PO 918477, R3022258.PDF for PO 918498).

import { pdfLayoutText } from "./pdf-layout";
import type { ContainerLine, ContainerRecord, ParseResult } from "./types";
import { ISO6346, isValidContainerNo } from "./types";

/** "10/19/26" → "2026-10-19" */
function usDate(s: string | undefined): string | undefined {
  const m = s && /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return undefined;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function findContainers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/Container\s*#?\s*:?\s*([A-Z]{4}\s?\d{7})\b/gi)) found.add(m[1].replace(/\s/g, "").toUpperCase());
  return [...found];
}

function checkContainers(nos: string[], label: string, warnings: string[]): string {
  if (!nos.length) { warnings.push(`${label}: no Container# found`); return ""; }
  for (const c of nos) if (!isValidContainerNo(c)) warnings.push(`${label}: container ${c} fails ISO 6346 check digit`);
  if (nos.length > 1) warnings.push(`${label}: ${nos.length} containers printed (${nos.join(", ")}) — lines attributed to ${nos[0]}`);
  return nos[0];
}

/** Hayward US invoice. One PDF = one invoice = one PO (per the subject line); may span pages. */
export async function parseUsInvoice(buf: Buffer, observedAt: string): Promise<ParseResult> {
  const text = (await pdfLayoutText(buf)).join("\n");
  const warnings: string[] = [];

  // "Invoice Date   Invoice Number" header; a row "10/19/26   13455739" follows within a few lines
  const invoiceNo = /Invoice Number[\s\S]{0,600}?\d{1,2}\/\d{1,2}\/\d{2}\s+(\d{7,10})\b/.exec(text)?.[1] ?? "";
  // Row under "Customer No.  Customer's Purchase Order Number  Date Shipped …": "400033  918477  9/25/26  1  436908-04  NET 90 DAYS"
  const hdrRow = /Customer No\.[^\n]*\n\s*(\d{6})\s+(\d{6})\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+\d+\s+(\S+)/.exec(text);
  const po = hdrRow?.[2] ?? "";
  const shipDate = usDate(hdrRow?.[3]);
  const usSalesOrder = hdrRow?.[4];
  const label = `US invoice ${invoiceNo || "?"}`;
  if (!po) warnings.push(`${label}: PO not found`);
  const containerNo = checkContainers(findContainers(text), label, warnings);

  // Item line: <ordered> <ITEM> <description…>  <B/O> <shipped> <unit price> <% disc> <extended>
  // Extended can print as ".00" with no leading digit when nothing shipped.
  const lineRe = /^\s*(\d+)\s+([A-Z0-9][A-Z0-9\-\/\.]{1,})\s+(.*?)\s{2,}(\d+)\s+(\d+)\s+([\d,]*\.\d{2})\s+([\d.]*)\s+([\d,]*\.\d{2})\s*$/;
  const lines: ContainerLine[] = [];
  let backordered = 0;
  for (const raw of text.split("\n")) {
    const m = lineRe.exec(raw);
    if (!m) continue;
    const shipped = Number(m[5]);
    if (shipped <= 0) { backordered++; continue; } // on back-order — not in this box
    lines.push({
      po, supplierItem: m[2], qty: shipped, source: "us-invoice", sourceRef: invoiceNo,
      description: m[3].trim(), unitCost: Number(m[6].replace(/,/g, "")) || undefined, observedAt,
    });
  }
  if (!lines.length) warnings.push(`${label}: no shipped item lines parsed${backordered ? ` (${backordered} back-ordered)` : ""}`);

  const fob = /F\.O\.B\.\s+([A-Z][A-Z ,]+?)\s{2,}/.exec(text)?.[1]?.replace(/\s*-PPD.*$/, "").trim();
  const containers: Partial<ContainerRecord>[] = containerNo ? [{
    containerNo, vendor: "HAYWARD INDUSTRIES, INC.", shipMode: /Shipped Via[\s\S]{0,200}?\bAIR\b/.test(text) ? "A" : "O",
    originPort: fob, etd: shipDate, invoiceNos: invoiceNo ? [invoiceNo] : [],
    pos: po ? [po] : [], sources: ["us-invoice"], firstSeen: observedAt, lastSeen: observedAt,
    lines: [],
  }] : [];
  if (usSalesOrder && !lines.length && !containerNo) warnings.push(`${label}: US SO ${usSalesOrder} parsed but no lines/container`);
  return { lines, containers, warnings };
}

/** Hayward Wuxi packing slip. One PDF = one PO; lists the whole PO with a "Qty This Shipment" column. */
export async function parseWuxiPackingSlip(buf: Buffer, observedAt: string): Promise<ParseResult> {
  const text = (await pdfLayoutText(buf)).join("\n");
  const warnings: string[] = [];

  const orderNo = /Order #\s*:\s*(\S+)/.exec(text)?.[1] ?? "";
  const po = /Customer PO\s*:\s*(\d{6})/.exec(text)?.[1] ?? "";
  const shipDate = usDate(/Ship Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2})/.exec(text)?.[1]);
  const label = `Wuxi slip ${orderNo || "?"}`;
  if (!po) warnings.push(`${label}: Customer PO not found`);
  const containerNo = checkContainers(findContainers(text), label, warnings);

  // <ordered> <prior> <this> <future>  <ITEM (may contain one space)>   <description>
  const lineRe = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z0-9][A-Z0-9\-\/\. ]{1,30}?)\s{2,}(\S.*)$/;
  const lines: ContainerLine[] = [];
  for (const raw of text.split("\n")) {
    const m = lineRe.exec(raw);
    if (!m) continue;
    const thisShipment = Number(m[3]);
    if (thisShipment <= 0) continue; // ordered but shipping later
    lines.push({
      po, supplierItem: m[5].trim(), qty: thisShipment, source: "wuxi-packing-slip", sourceRef: orderNo,
      description: m[6].trim(), observedAt,
    });
  }
  if (!lines.length) warnings.push(`${label}: nothing in the "This Shipment" column`);

  const containers: Partial<ContainerRecord>[] = containerNo ? [{
    containerNo, vendor: "HAYWARD INDUSTRIES, WUXI CHINA", shipMode: /Ship Via\s*:\s*AIR/i.test(text) ? "A" : "O",
    originPort: /FOB\s*:\s*([A-Z][A-Z ,]+?)\s{2,}/.exec(text)?.[1]?.replace(/\s*-PPD.*$/, "").trim(),
    etd: shipDate, packingSlipNos: orderNo ? [orderNo] : [],
    pos: po ? [po] : [], sources: ["wuxi-packing-slip"], firstSeen: observedAt, lastSeen: observedAt, lines: [],
  }] : [];
  return { lines, containers, warnings };
}

/** Order acknowledgements etc. come from the same robot@ sender — recognise what we can't use. */
export function looksLikePackingSlip(filename: string) { return /^R\d{6,8}\.pdf$/i.test(filename); }
export function looksLikeUsInvoice(filename: string) { return /INVOICE/i.test(filename) && /\.pdf$/i.test(filename); }

/** Route one PDF attachment to the right parser from sender + filename. Returns null when it's neither. */
export async function parseSupplierPdf(sender: string, filename: string, buf: Buffer, observedAt: string): Promise<ParseResult | null> {
  const s = (sender ?? "").toLowerCase();
  if (looksLikeUsInvoice(filename) || s.includes("sbateman@hayward.com")) return parseUsInvoice(buf, observedAt);
  if (looksLikePackingSlip(filename) || s.includes("robot@hayward.com")) return parseWuxiPackingSlip(buf, observedAt);
  // Unknown PDF: sniff for a container number so nothing slips through silently
  const text = (await pdfLayoutText(buf)).join("\n");
  const hit = /([A-Z]{4}\d{7})/.exec(text.replace(/\s/g, ""));
  if (hit && ISO6346.test(hit[1])) return { lines: [], containers: [], warnings: [`unrouted PDF ${filename} from ${sender} mentions ${hit[1]}`] };
  return null;
}
