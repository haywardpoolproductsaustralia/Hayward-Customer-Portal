// lib/containers/store.ts
// Redis state for containers. One key per container plus an index:
//   ct:container:<no>   ContainerRecord  (facts from every document + ShipsGo live status + the PO lines inside)
//   ct:index            string[] of container numbers
//   ct:meta             last ingest summary      ct:failed  last 100 ingest failures     ct:refresh  last cron run
//   ct:seen:<msgid>     de-dupe marks for emails (90 days)

import { redis, getJSON } from "@/lib/redis";
import type { ContainerLine, ContainerRecord, ContainerSource, LiveStatus, ParseResult } from "./types";

export const K = {
  container: (n: string) => `ct:container:${n}`,
  invoice: (n: string) => `ct:inv:${n}`,     // invoice no → { po, lines } so the schedule can resolve its invoice lists
  index: "ct:index",
  meta: "ct:meta",
  failed: "ct:failed",
  refresh: "ct:refresh",
  seen: (id: string) => `ct:seen:${id}`,
};

// When two documents disagree on a fact, the higher source wins; lower ones only fill gaps.
const PRIORITY: Record<ContainerSource, number> = { shipsgo: 7, century: 6, chr: 5, cds: 4, "wuxi-packing-slip": 3, "us-invoice": 2, schedule: 1 };
const FACT_KEYS: (keyof ContainerRecord)[] = [
  "mbl", "hbl", "forwarder", "vendor", "originPort", "destPort", "shipMode", "vessel", "voyage", "etd", "eta", "deliveredDate", "size", "shipKey", "destCountry",
];

export async function getIndex(): Promise<string[]> {
  return (await getJSON<string[]>(K.index)) ?? [];
}
export async function getRecord(no: string): Promise<ContainerRecord | null> {
  return getJSON<ContainerRecord>(K.container(no));
}
export async function saveRecord(rec: ContainerRecord): Promise<void> {
  await redis.set(K.container(rec.containerNo), JSON.stringify(rec));
}
export async function getAllRecords(): Promise<ContainerRecord[]> {
  const index = await getIndex();
  if (!index.length) return [];
  const out: ContainerRecord[] = [];
  for (let i = 0; i < index.length; i += 100) {
    const chunk = index.slice(i, i + 100);
    const vals = await redis.mget<(ContainerRecord | string | null)[]>(...chunk.map(K.container));
    for (const v of vals) {
      if (v == null) continue;
      if (typeof v === "string") { try { out.push(JSON.parse(v)); } catch { /* skip */ } }
      else out.push(v as ContainerRecord);
    }
  }
  return out;
}

async function addToIndex(nos: string[]) {
  const index = new Set(await getIndex());
  let changed = false;
  for (const n of nos) if (!index.has(n)) { index.add(n); changed = true; }
  if (changed) await redis.set(K.index, JSON.stringify([...index]));
}

function mergeFacts(existing: ContainerRecord, incoming: Partial<ContainerRecord>): ContainerRecord {
  const incPri = Math.max(0, ...(incoming.sources ?? []).map((s) => PRIORITY[s]));
  const exDocPri = Math.max(0, ...existing.sources.filter((s) => s !== "shipsgo").map((s) => PRIORITY[s]));
  const out: ContainerRecord = { ...existing };
  for (const k of FACT_KEYS) {
    const v = incoming[k];
    if (v == null || v === "") continue;
    if (out[k] == null || out[k] === "" || incPri >= exDocPri) (out as any)[k] = v;
  }
  if (incoming.century && (!out.century || incoming.century.updatedAt >= out.century.updatedAt)) out.century = incoming.century;
  if (incoming.chr && (!out.chr || incoming.chr.updatedAt >= out.chr.updatedAt)) out.chr = incoming.chr;
  if (incoming.schedule && (!out.schedule || incoming.schedule.updatedAt >= out.schedule.updatedAt)) out.schedule = incoming.schedule;
  out.sources = [...new Set([...existing.sources, ...(incoming.sources ?? [])])];
  out.pos = [...new Set([...existing.pos, ...(incoming.pos ?? [])])];
  out.invoiceNos = [...new Set([...(existing.invoiceNos ?? []), ...(incoming.invoiceNos ?? [])])];
  out.packingSlipNos = [...new Set([...(existing.packingSlipNos ?? []), ...(incoming.packingSlipNos ?? [])])];
  if (incoming.firstSeen && incoming.firstSeen < out.firstSeen) out.firstSeen = incoming.firstSeen;
  if (incoming.lastSeen && incoming.lastSeen > out.lastSeen) out.lastSeen = incoming.lastSeen;
  return out;
}

/**
 * Persist a parse result. Lines are replaced per (container, source), so a re-sent CDS report or a
 * re-forwarded invoice never duplicates. Returns the containers we had never seen before.
 */
export async function applyParseResult(r: ParseResult): Promise<{ newContainers: string[]; touched: string[] }> {
  const newContainers: string[] = [];
  const touched = new Set<string>();

  // Lines per container: a container entry that carries its own `lines` (CDS) wins; otherwise, when the
  // document names exactly one container (supplier PDFs), every top-level line belongs to it.
  const byContainer = new Map<string, ContainerLine[]>();
  const facts = new Map<string, Partial<ContainerRecord>>();
  for (const c of r.containers) {
    if (!c.containerNo) continue;
    facts.set(c.containerNo, c);
    if (c.lines?.length) byContainer.set(c.containerNo, [...c.lines]);
  }
  if (r.containers.length === 1 && !byContainer.size && r.lines.length) byContainer.set(r.containers[0].containerNo!, [...r.lines]);

  for (const no of new Set([...facts.keys(), ...byContainer.keys()])) {
    const incomingFacts = facts.get(no) ?? { containerNo: no, sources: [], pos: [], firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() };
    const incomingLines = byContainer.get(no) ?? [];
    const sourcesIn = new Set<ContainerSource>([...(incomingFacts.sources ?? []), ...incomingLines.map((l) => l.source)]);
    let rec = await getRecord(no);
    if (!rec) {
      newContainers.push(no);
      rec = { containerNo: no, pos: [], lines: [], sources: [], firstSeen: incomingFacts.firstSeen ?? new Date().toISOString(), lastSeen: incomingFacts.lastSeen ?? new Date().toISOString() };
    }
    rec = mergeFacts(rec, { ...incomingFacts, sources: [...sourcesIn] });
    if (incomingLines.length) {
      const replaced = new Set(incomingLines.map((l) => l.source));
      rec.lines = [...rec.lines.filter((l) => !replaced.has(l.source)), ...incomingLines];
    }
    rec.pos = [...new Set([...rec.pos, ...rec.lines.map((l) => l.po)])];
    await saveRecord(rec);
    touched.add(no);
  }
  await addToIndex([...touched]);
  return { newContainers, touched: [...touched] };
}

/** Index the lines of a supplier invoice / packing slip by its number (with or without a container), so a later
 *  document that only names the invoice (Dimi's schedule) can place those lines in a box. */
export async function indexInvoiceLines(r: ParseResult): Promise<number> {
  const byRef = new Map<string, ContainerLine[]>();
  for (const l of r.lines) if (l.sourceRef && (l.source === "us-invoice" || l.source === "wuxi-packing-slip")) (byRef.get(l.sourceRef) ?? byRef.set(l.sourceRef, []).get(l.sourceRef)!).push(l);
  for (const [ref, lines] of byRef) await redis.set(K.invoice(ref.replace(/^0+/, "")), JSON.stringify({ po: lines[0].po, lines }), { ex: 60 * 60 * 24 * 400 });
  return byRef.size;
}
export async function getInvoiceLines(no: string): Promise<{ po: string; lines: ContainerLine[] } | null> {
  return getJSON<{ po: string; lines: ContainerLine[] }>(K.invoice(no.replace(/^0+/, "")));
}

/** Attach / refresh ShipsGo live status on a record (creating a ShipsGo-only record when we've never seen the box in a document). */
export async function applyLive(no: string, live: LiveStatus, posFromReference: string[] = []): Promise<ContainerRecord> {
  let rec = await getRecord(no);
  const now = new Date().toISOString();
  if (!rec) {
    rec = { containerNo: no, pos: [], lines: [], sources: [], firstSeen: now, lastSeen: now };
    await addToIndex([no]);
  }
  rec.live = live;
  if (!rec.sources.includes("shipsgo")) rec.sources.push("shipsgo");
  rec.pos = [...new Set([...rec.pos, ...posFromReference])];
  rec.lastSeen = now;
  if (!rec.registration) rec.registration = { shipmentId: live.shipmentId, by: "manual", number: no, at: now };
  await saveRecord(rec);
  return rec;
}

/** Is this box finished (at our door or returned)? Used to stop polling / registering. */
export function isClosed(rec: ContainerRecord, staleDays = 45): boolean {
  if (rec.live?.containerStatus && ["GATE_OUT", "EMPTY_RETURN"].includes(rec.live.containerStatus)) return true;
  if (rec.century?.status && ["GATE_OUT", "EMPTY_RETURN"].includes(rec.century.status)) return true;
  if (rec.chr?.status && ["GATE_OUT", "EMPTY_RETURN"].includes(rec.chr.status)) return true;
  if (rec.deliveredDate) return true;
  const cutoff = new Date(Date.now() - staleDays * 86400e3).toISOString().slice(0, 10);
  const eta = rec.live?.eta ?? rec.eta;
  return !!eta && eta < cutoff; // CDS never sets Delivered — an ETA 45+ days ago means it landed long ago
}
