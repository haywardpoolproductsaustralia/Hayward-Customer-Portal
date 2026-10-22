// lib/containers/ingest.ts
// One entry point for every container document, whichever way it arrives:
//   • Power Automate flow on the AU Containers mailbox  → /api/containers/ingest  (JSON, base64 attachments)
//   • Staff dropping files on the Purchasing page        → /api/containers/upload  (PDF / xlsx / .msg)
// Recognises the sender/subject/filename, parses, merges into the container store, writes the CDS
// line index the page already reads, and (optionally) registers new boxes with ShipsGo.

import { parseShipmentWorkbook } from "@/lib/recon/shipmentIngest";
import { getJSON, redis } from "@/lib/redis";
import { parseCdsContainers } from "./parse-cds";
import { isCenturyCsv, parseCenturyCsv } from "./parse-century";
import { looksLikePackingSlip, looksLikeUsInvoice, parseSupplierPdf } from "./parse-supplier-docs";
import { applyParseResult, K } from "./store";
import { registerNew } from "./tracking";
import type { ParseResult } from "./types";

export interface InboundAttachment { name: string; contentType?: string; content: Buffer }
export interface InboundEmail {
  from: string;
  subject: string;
  receivedDateTime: string;
  messageId?: string;
  attachments: InboundAttachment[];
}

const CDS_SENDER = "noreply@cds-net.com";
const SUPPLIER_SENDERS = ["sbateman@hayward.com", "robot@hayward.com"];
const isCdsFile = (n: string) => /shipment\s*activity\s*by\s*container/i.test(n) && /\.xlsx?$/i.test(n);

/** "FW: FW: Inv#: …" → "Inv#: …" — forwards carry prefixes; redirects don't. */
export const bareSubject = (s: string) => (s ?? "").replace(/^(\s*(fw|fwd|re|aw|tr)\s*:\s*)+/i, "").trim();

export function isContainerEmail(m: { from: string; subject: string; attachments: Array<{ name: string }> }): boolean {
  const f = (m.from ?? "").toLowerCase();
  const subj = bareSubject(m.subject);
  const names = m.attachments.map((a) => a.name);
  return f.includes(CDS_SENDER) || SUPPLIER_SENDERS.some((s) => f.includes(s)) ||
    /^Inv#?:?\s*\d+\s+PO:?\s*\d{6}/i.test(subj) || /^Hayward Shipment for PO/i.test(subj) || /^Shipment Activity by Container/i.test(subj) ||
    names.some((n) => isCdsFile(n) || looksLikeUsInvoice(n) || looksLikePackingSlip(n) || (/\.csv$/i.test(n) && isCenturyCsv(n)));
}

export interface IngestOutcome {
  parsed: { lines: number; containers: number; cdsLines?: number };
  newContainers: string[];
  touched: string[];
  warnings: string[];
  registration: Awaited<ReturnType<typeof registerNew>> | null;
  skippedAttachments: string[];
}

export async function ingestEmail(m: InboundEmail, opts: { register?: boolean; dryRun?: boolean } = {}): Promise<IngestOutcome> {
  const observedAt = m.receivedDateTime || new Date().toISOString();
  const results: ParseResult[] = [];
  const skipped: string[] = [];
  let cdsLines: number | undefined;

  for (const att of m.attachments) {
    const name = att.name ?? "";
    if (/\.xlsx?$/i.test(name) && (isCdsFile(name) || m.from.toLowerCase().includes(CDS_SENDER))) {
      // 1) the per-line index the page has always used (replaces the manual upload)
      const lines = parseShipmentWorkbook(att.content);
      cdsLines = lines.length;
      await redis.set("recon:shipment_index", JSON.stringify(lines));
      await redis.set("recon:shipment_meta", JSON.stringify({ receivedAt: observedAt, subject: m.subject, rows: lines.length, file: name, filename: name }));
      // 2) container-level facts (MBL, voyage, ship key) for the tracking store
      results.push(parseCdsContainers(att.content, observedAt));
    } else if (/\.csv$/i.test(name)) {
      const head = att.content.subarray(0, 600).toString("utf8");
      if (isCenturyCsv(name) || isCenturyCsv(head)) results.push(parseCenturyCsv(att.content, observedAt)); else skipped.push(name);
    } else if (/\.pdf$/i.test(name)) {
      const r = await parseSupplierPdf(m.from, name, att.content, observedAt);
      if (r) results.push(r); else skipped.push(name);
    } else {
      skipped.push(name); // signature images etc.
    }
  }

  const merged: ParseResult = {
    lines: results.flatMap((r) => r.lines),
    containers: results.flatMap((r) => r.containers),
    warnings: results.flatMap((r) => r.warnings),
  };
  const subjPo = /PO:?\s*(\d{6})/i.exec(bareSubject(m.subject))?.[1];
  const parsedPos = new Set(merged.lines.map((l) => l.po));
  if (subjPo && parsedPos.size && !parsedPos.has(subjPo)) merged.warnings.push(`subject says PO ${subjPo} but the document is for ${[...parsedPos].join(",")}`);

  const { newContainers, touched } = await applyParseResult(merged);
  const registration = opts.register && touched.length ? await registerNew(touched, opts.dryRun) : null;

  const prevMeta = (await getJSON<any>(K.meta)) ?? {};
  const sourcesSeen = new Set(merged.lines.map((l) => l.source));
  await redis.set(K.meta, JSON.stringify({
    ...prevMeta,
    lastIngestAt: new Date().toISOString(), lastSubject: m.subject, lastFrom: m.from,
    ...(sourcesSeen.has("century") ? { lastCenturyAt: observedAt } : {}),
    ...(cdsLines != null ? { lastCdsAt: observedAt } : {}),
    parsed: { lines: merged.lines.length, containers: merged.containers.length, cdsLines }, newContainers: newContainers.length, warnings: merged.warnings,
  }));
  return { parsed: { lines: merged.lines.length, containers: merged.containers.length, cdsLines }, newContainers, touched, warnings: merged.warnings, registration, skippedAttachments: skipped };
}

/** Outlook .msg (saved from Dimi's mailbox) → InboundEmail. Attachments come out as Buffers. */
export async function emailFromMsg(buf: Buffer, fallbackName = "message.msg"): Promise<InboundEmail> {
  const mod: any = await import("@kenjiuno/msgreader");
  const MsgReader = mod.default ?? mod.MsgReader ?? mod;
  const reader = new MsgReader(new Uint8Array(buf));
  const data = reader.getFileData();
  const attachments: InboundAttachment[] = [];
  for (const a of data.attachments ?? []) {
    if (a.innerMsgContent) continue;
    const c = reader.getAttachment(a);
    if (!c?.content) continue;
    // msgreader leaves a trailing NUL on fileName; senders can carry trailing spaces
    const name = String(a.fileName ?? a.name ?? fallbackName).replace(/\0+$/g, "").trim();
    attachments.push({ name, contentType: a.attachMimeTag, content: Buffer.from(c.content) });
  }
  const msgId = /Message-ID:\s*(<[^>]+>)/i.exec(data.headers ?? "")?.[1];
  const when = data.messageDeliveryTime ?? data.clientSubmitTime;
  return {
    from: String(data.senderSmtpAddress ?? data.senderEmail ?? data.senderName ?? "").replace(/\0+$/g, "").trim(),
    subject: String(data.subject ?? fallbackName).replace(/\0+$/g, "").trim(),
    receivedDateTime: when ? new Date(when).toISOString() : new Date().toISOString(),
    messageId: msgId,
    attachments,
  };
}

/** A bare file dropped on the page — wrap it as a one-attachment email so the same routing applies. */
export function emailFromFile(name: string, content: Buffer, receivedDateTime = new Date().toISOString()): InboundEmail {
  const from = looksLikeUsInvoice(name) ? "sbateman@hayward.com" : looksLikePackingSlip(name) ? "robot@hayward.com" : isCdsFile(name) ? CDS_SENDER : "";
  // A Century CSV with an unhelpful filename is recognised by its header
  const csvName = /\.csv$/i.test(name) && !isCenturyCsv(name) && isCenturyCsv(content.subarray(0, 600).toString("utf8")) ? `century-${name}` : name;
  return { from, subject: `upload: ${name}`, receivedDateTime, attachments: [{ name: csvName, content }] };
}
