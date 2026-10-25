// lib/containers/tracking.ts
// Two jobs:
//   registerNew()     — after a document is parsed, decide which new containers to put on ShipsGo and do it,
//                       spending as few credits as possible.
//   syncFromShipsgo() — pull every shipment on the ShipsGo account (including ones Dimi/Joe added by hand in
//                       the dashboard) and fold live status, ETA and movements into the container records.
//
// Credit rules (registerNew):
//   1. already registered / already on the account (free lookup)                      → link, no credit
//   2. closed: GATE_OUT / EMPTY_RETURN / CDS delivered / ETA older than CT_STALE_DAYS    → skip
//   3. air shipment                                                                     → skip
//   4. CT_REGISTER_SCOPE=gap (default): skip containers CDS already covers, and skip China-origin boxes
//      (Wuxi slip, or a US invoice marked F.O.B. WUXI) that CDS WILL cover once booked — the point of ShipsGo
//      here is the US-origin boxes CDS never shows. =all tracks everything we see.
//   5. has an MBL (from CDS)        → one booking_number registration covers every box under the bill
//   6. only the container no. known → container_number registration (carrier guessed from the prefix, else auto)

import * as sg from "./shipsgo";
import { applyLive, getAllRecords, getRecord, isClosed, saveRecord } from "./store";
import type { ContainerRecord } from "./types";

const STALE_DAYS = Number(process.env.CT_STALE_DAYS ?? 45);
const SCOPE = (process.env.CT_REGISTER_SCOPE ?? "gap") as "gap" | "all";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Hayward warehouse: PO918457, 918462, 918477" → ["918457","918462","918477"] */
export function posFromReference(ref?: string | null): string[] {
  return [...new Set([...(ref ?? "").matchAll(/\b(9\d{5})\b/g)].map((m) => m[1]))];
}

const isChinaOrigin = (r: ContainerRecord) =>
  /WUXI|CHINA|SHANGHAI|TAICANG|NINGBO|SHENZHEN|YANTIAN|QINGDAO/i.test(`${r.originPort ?? ""} ${r.vendor ?? ""}`) || r.sources.includes("wuxi-packing-slip");

export interface RegisterItem { by: "container_number" | "booking_number"; number: string; containers: string[]; reason: string }
export interface RegisterOutcome { item: RegisterItem; ok: boolean; shipmentId?: number; note?: string; error?: string }

export async function planRegistrations(nos: string[]): Promise<{ plan: RegisterItem[]; skipped: Array<{ containerNo: string; why: string }> }> {
  const plan: RegisterItem[] = [];
  const skipped: Array<{ containerNo: string; why: string }> = [];
  const byBl = new Map<string, string[]>();
  for (const no of nos) {
    const rec = await getRecord(no);
    if (!rec) continue;
    if (rec.registration) { skipped.push({ containerNo: no, why: `registered ${rec.registration.at.slice(0, 10)}` }); continue; }
    if (isClosed(rec, STALE_DAYS)) { skipped.push({ containerNo: no, why: rec.deliveredDate ? `delivered ${rec.deliveredDate}` : `closed/stale (ETA ${rec.live?.eta ?? rec.eta})` }); continue; }
    if (rec.shipMode === "A") { skipped.push({ containerNo: no, why: "air" }); continue; }
    if (SCOPE === "gap") {
      if (rec.sources.includes("cds") || rec.sources.includes("century") || rec.sources.includes("chr")) { skipped.push({ containerNo: no, why: "a forwarder feed (CDS/Century/CHR) already tracks it (CT_REGISTER_SCOPE=gap)" }); continue; }
      if (isChinaOrigin(rec)) { skipped.push({ containerNo: no, why: `China origin (${rec.originPort ?? rec.vendor}) — CDS will carry it (CT_REGISTER_SCOPE=gap)` }); continue; }
    }
    if (rec.mbl) (byBl.get(rec.mbl) ?? byBl.set(rec.mbl, []).get(rec.mbl)!).push(no);
    else plan.push({ by: "container_number", number: no, containers: [no], reason: `container only (${rec.sources.join("+")})` });
  }
  for (const [mbl, containers] of byBl) plan.push({ by: "booking_number", number: mbl, containers, reason: `MBL covers ${containers.length} box(es)` });
  return { plan, skipped };
}

async function linkShipment(s: sg.SgShipment, containers: string[], by: RegisterItem["by"] | "manual", number: string) {
  const full = s.containers?.length ? s : await sg.getShipment(s.id);
  const refPos = posFromReference(full.reference);
  const nos = new Set<string>([...containers, ...(full.containers ?? []).map((c) => c.number.toUpperCase())]);
  for (const no of nos) {
    const prev = (await getRecord(no))?.live;
    const rec = await applyLive(no, sg.toLiveStatus(full, no, prev), refPos);
    rec.registration = { shipmentId: full.id, by, number, at: new Date().toISOString() };
    await saveRecord(rec);
  }
}

export async function executeRegistrations(plan: RegisterItem[], dryRun = false): Promise<RegisterOutcome[]> {
  const out: RegisterOutcome[] = [];
  for (const item of plan) {
    try {
      // Free lookup first — Dimi may already have added it in the dashboard.
      const existing = item.by === "container_number" ? await sg.findByContainerNumber(item.number) : await sg.findByBookingNumber(item.number);
      if (existing) {
        if (!dryRun) await linkShipment(existing, item.containers, item.by, item.number);
        out.push({ item, ok: true, shipmentId: existing.id, note: "already on ShipsGo — linked, no credit" });
        continue;
      }
      if (dryRun) { out.push({ item, ok: true, note: "dry-run: would register" }); continue; }
      const pos = new Set<string>();
      for (const no of item.containers) (await getRecord(no))?.pos.forEach((p) => pos.add(p));
      const carrier = item.by === "booking_number" ? sg.scacFromMbl(item.number) : sg.scacFromContainer(item.number);
      const s = await sg.createShipment(item.by, item.number, {
        carrier, reference: `Hayward AU PO ${[...pos].join(", ")}`.slice(0, 100), tags: ["portal-auto"],
      });
      await linkShipment(s, item.containers, item.by, item.number);
      out.push({ item, ok: true, shipmentId: s.id, note: `registered (credits left: ${sg.lastCredits.remaining ?? "?"})` });
    } catch (e: any) {
      const dup = sg.duplicateShipment(e);
      if (dup) {
        try { await linkShipment(dup, item.containers, item.by, item.number); out.push({ item, ok: true, shipmentId: dup.id, note: "already tracked (409) — linked, no credit" }); continue; }
        catch (e2: any) { out.push({ item, ok: false, error: `409 link failed: ${e2?.message}` }); continue; }
      }
      out.push({ item, ok: false, error: sg.isOutOfCredits(e) ? `out of ShipsGo credits: ${e.message}` : e?.message ?? String(e) });
    }
    await sleep(300);
  }
  return out;
}

export async function registerNew(nos: string[], dryRun = false) {
  const { plan, skipped } = await planRegistrations(nos);
  const results = plan.length ? await executeRegistrations(plan, dryRun) : [];
  return { plan, skipped, results };
}

/**
 * Pull the whole ShipsGo account and update our records. Summaries are one call per 100 shipments;
 * the detail (containers + movements) is one call per shipment, skipped when ShipsGo's updated_at
 * hasn't moved since we last looked. Runs on the 2-hourly cron and from the page's "Refresh" button.
 */
export async function syncFromShipsgo(opts: { force?: boolean; limit?: number } = {}) {
  const started = Date.now();
  // ShipsGo sets discarded_at when it stops tracking a shipment after discharge — those still show in the dashboard
  // and still carry their final status/ETA/movements, so we pull them once and then treat them as closed.
  const summaries = await sg.listAllShipments();
  const records = new Map((await getAllRecords()).map((r) => [r.containerNo, r] as const));
  const changed: Array<{ containerNo: string; from?: string; to?: string; status?: string }> = [];
  const errors: Array<{ shipmentId: number; error: string }> = [];
  let detailCalls = 0, containersTouched = 0, newFromShipsgo = 0;

  for (const s of summaries) {
    if (opts.limit && detailCalls >= opts.limit) break;
    const known = [...records.values()].filter((r) => r.live?.shipmentId === s.id);
    const unchanged = known.length && known.every((r) => r.live?.sourceUpdatedAt && r.live.sourceUpdatedAt === s.updated_at);
    const terminal = known.length && known.every((r) => isClosed(r, STALE_DAYS));
    if (!opts.force && (unchanged || terminal)) continue;
    try {
      const full = await sg.getShipment(s.id);
      detailCalls++;
      const refPos = posFromReference(full.reference);
      for (const c of full.containers ?? []) {
        const no = c.number.toUpperCase();
        const prev = records.get(no);
        const live = sg.toLiveStatus(full, no, prev?.live);
        live.sourceUpdatedAt = s.updated_at;
        if (s.discarded_at) live.discardedAt = s.discarded_at;
        if (!prev) newFromShipsgo++;
        const rec = await applyLive(no, live, refPos);
        records.set(no, rec);
        containersTouched++;
        if (prev?.live?.eta !== live.eta || prev?.live?.containerStatus !== live.containerStatus) {
          changed.push({ containerNo: no, from: prev?.live?.eta, to: live.eta, status: live.containerStatus });
        }
      }
      await sleep(650); // 100 req/min
    } catch (e: any) {
      errors.push({ shipmentId: s.id, error: e?.message ?? String(e) });
    }
  }
  return {
    at: new Date().toISOString(), ms: Date.now() - started, shipments: summaries.length, detailCalls, containersTouched, newFromShipsgo,
    changed, errors, credits: sg.lastCredits,
  };
}

export function describe(r: ContainerRecord) {
  return `${r.containerNo} POs ${r.pos.join("/")} ${r.live?.containerStatus ?? "-"} ETA ${r.live?.eta ?? r.eta ?? "?"} [${r.sources.join("+")}]`;
}
