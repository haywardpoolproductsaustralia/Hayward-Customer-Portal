// lib/containers/shipsgo.ts
// ShipsGo Ocean API v2 client — the provider Hayward already holds credits for.
//
//   Base   https://api.shipsgo.com/v2         Auth header  X-Shipsgo-User-Token  (dashboard → Integrations → API Tokens)
//   POST   /ocean/shipments                   { container_number | booking_number, carrier?: SCAC, reference?, tags?: [] }
//   GET    /ocean/shipments?skip&take&filters[container_number]=eq:XXXX1234567     → { shipments: [summary…], meta: { more } }
//   GET    /ocean/shipments/{id}              → { shipment: { …, containers: [{ number, status, movements: [...] }] } }
//   Response headers X-Shipsgo-Credits-Cost / X-Shipsgo-Credits-Remaining. 100 req/min per account.
//   One credit per shipment created; every container under one booking/MBL shares it.
//   Timestamps are local port time "YYYY-MM-DD HH:MM:SS".
// Field names confirmed against the official OpenAPI 3.1 spec "ShipsGo API 2.0" (api.shipsgo.com/v2, 21 Oct 2026):
//   POST → 200 { message, shipment }, 402 { message: "NOT_ENOUGH_CREDITS" }, 409 { message, shipment } (already tracked — no credit)
//   tokens.map → https://map.shipsgo.com/ocean/shipments/{id}?token={map}   route.port_of_discharge.date_of_discharge_predicted

import type { LiveStatus, Movement } from "./types";

const BASE = process.env.SHIPSGO_API_BASE ?? "https://api.shipsgo.com/v2";
const token = () => process.env.SHIPSGO_USER_TOKEN ?? "";

export class ShipsgoError extends Error {
  status: number; body: any;
  constructor(status: number, path: string, body: any, text: string) {
    super(`ShipsGo ${path} → ${status}: ${text.slice(0, 300)}`);
    this.status = status; this.body = body;
  }
}

export let lastCredits: { cost?: number; remaining?: number } = {};

async function call(path: string, init: RequestInit = {}): Promise<any> {
  if (!token()) throw new Error("SHIPSGO_USER_TOKEN not set");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "X-Shipsgo-User-Token": token(), Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  const cost = res.headers.get("x-shipsgo-credits-cost"), rem = res.headers.get("x-shipsgo-credits-remaining");
  if (cost != null || rem != null) lastCredits = { cost: cost != null ? Number(cost) : undefined, remaining: rem != null ? Number(rem) : undefined };
  if (!res.ok) throw new ShipsgoError(res.status, path, body, text);
  return body;
}

/* ---------- shapes (subset of the v2 payload we use) ---------- */
export interface SgLocation { code?: string; name?: string; timezone?: string; country?: { code?: string; name?: string } }
export interface SgMovement { event: string; status: "ACT" | "EST"; location?: SgLocation; vessel?: { imo?: number; name?: string }; voyage?: string; timestamp: string }
export interface SgContainer { number: string; status?: string; size?: number; type?: string; movements?: SgMovement[] }
export interface SgShipment {
  id: number; reference?: string | null; booking_number?: string | null; container_number?: string | null; container_count?: number;
  carrier?: { scac?: string; name?: string } | null; status?: string;
  route?: {
    port_of_loading?: { location?: SgLocation; date_of_loading?: string | null; date_of_loading_initial?: string | null } | null;
    port_of_discharge?: { location?: SgLocation; date_of_discharge?: string | null; date_of_discharge_initial?: string | null; date_of_discharge_predicted?: string | null } | null;
    ts_count?: number | null; transit_time?: number | null; transit_percentage?: number | null; co2_emission?: number | null;
  } | null;
  containers?: SgContainer[];
  tokens?: { map?: string };
  tags?: Array<{ id?: number; name?: string }>;
  created_at?: string; updated_at?: string; checked_at?: string | null; discarded_at?: string | null;
}

const d = (v?: string | null) => (v ? String(v).slice(0, 10) : undefined);

/** Fold one ShipsGo shipment (+ the specific container inside it) into our LiveStatus. */
export function toLiveStatus(s: SgShipment, containerNo: string, previous?: LiveStatus): LiveStatus {
  const c = (s.containers ?? []).find((x) => (x.number ?? "").toUpperCase() === containerNo) ?? s.containers?.[0];
  const movements: Movement[] = (c?.movements ?? []).map((m) => ({
    event: m.event, status: m.status, location: m.location?.name, locationCode: m.location?.code,
    vessel: m.vessel?.name, voyage: m.voyage ?? undefined, timestamp: m.timestamp,
  }));
  const eta = d(s.route?.port_of_discharge?.date_of_discharge);
  const etaChanged = !!(previous?.eta && eta && previous.eta !== eta);
  // Vessel/voyage: the latest actual sea leg, else the first planned one
  const legs = movements.filter((m) => m.vessel && ["LOAD", "DEPA", "ARRV", "DISC"].includes(m.event));
  const leg = [...legs].reverse().find((m) => m.status === "ACT") ?? legs[0];
  return {
    shipmentId: s.id, reference: s.reference ?? undefined, shipmentStatus: s.status, containerStatus: c?.status,
    carrier: s.carrier?.name ?? undefined, carrierScac: s.carrier?.scac ?? undefined,
    pol: s.route?.port_of_loading?.location?.name ?? undefined, pod: s.route?.port_of_discharge?.location?.name ?? undefined,
    etd: d(s.route?.port_of_loading?.date_of_loading), eta,
    etaInitial: d(s.route?.port_of_discharge?.date_of_discharge_initial),
    etaPredicted: d(s.route?.port_of_discharge?.date_of_discharge_predicted),
    mapUrl: s.tokens?.map ? `https://map.shipsgo.com/ocean/shipments/${s.id}?token=${encodeURIComponent(s.tokens.map)}` : undefined,
    previousEta: etaChanged ? previous!.eta : previous?.previousEta,
    etaChangedAt: etaChanged ? new Date().toISOString() : previous?.etaChangedAt,
    vessel: leg?.vessel, voyage: leg?.voyage,
    transitPercentage: s.route?.transit_percentage ?? undefined,
    movements, checkedAt: s.checked_at ?? undefined, updatedAt: new Date().toISOString(),
  };
}

/* ---------- calls ---------- */

/** Register a tracking. Costs one credit (ShipsGo reports the cost in the response headers). */
export async function createShipment(
  by: "container_number" | "booking_number", number: string,
  opts: { carrier?: string; reference?: string; tags?: string[] } = {},
): Promise<SgShipment> {
  const body: Record<string, unknown> = { [by]: number };
  if (opts.carrier) body.carrier = opts.carrier;
  if (opts.reference) body.reference = opts.reference.slice(0, 100);
  if (opts.tags?.length) body.tags = opts.tags;
  const res = await call("/ocean/shipments", { method: "POST", body: JSON.stringify(body) });
  return (res?.shipment ?? res) as SgShipment;
}

export async function getShipment(id: number | string): Promise<SgShipment> {
  const res = await call(`/ocean/shipments/${encodeURIComponent(String(id))}`);
  return (res?.shipment ?? res) as SgShipment;
}

export async function listShipments(skip = 0, take = 100, filters: Record<string, string> = {}): Promise<{ shipments: SgShipment[]; more: boolean }> {
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  for (const [k, v] of Object.entries(filters)) q.set(`filters[${k}]`, v);
  const res = await call(`/ocean/shipments?${q.toString()}`);
  const shipments: SgShipment[] = Array.isArray(res?.shipments) ? res.shipments : Array.isArray(res) ? res : [];
  return { shipments, more: !!res?.meta?.more || shipments.length === take };
}

/** Every shipment on the account (summaries — no containers/movements; call getShipment for those). */
export async function listAllShipments(): Promise<SgShipment[]> {
  const out: SgShipment[] = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const { shipments, more } = await listShipments(skip, 100);
    out.push(...shipments);
    if (!more || !shipments.length) break;
  }
  return out;
}

/** Is this container already tracked on the account? (free — no credit) */
export async function findByContainerNumber(containerNo: string): Promise<SgShipment | null> {
  const { shipments } = await listShipments(0, 1, { container_number: `eq:${containerNo}` });
  return shipments[0] ?? null;
}
export async function findByBookingNumber(booking: string): Promise<SgShipment | null> {
  const { shipments } = await listShipments(0, 1, { booking_number: `eq:${booking}` });
  return shipments[0] ?? null;
}

export const isDuplicate = (e: unknown) => e instanceof ShipsgoError && e.status === 409;
/** The 409 body carries the shipment that already tracks this number — link to it instead of looking it up. */
export const duplicateShipment = (e: unknown): SgShipment | null => (isDuplicate(e) && (e as ShipsgoError).body?.shipment) || null;
export const isOutOfCredits = (e: unknown) => e instanceof ShipsgoError && (e.status === 402 || /NOT_ENOUGH_CREDITS/i.test(JSON.stringify(e.body ?? "")));

/** Statuses after which nothing more will change — don't poll, don't register. */
export const TERMINAL_CONTAINER = new Set(["GATE_OUT", "EMPTY_RETURN"]);
export const TERMINAL_SHIPMENT = new Set(["UNTRACKED"]);

/** Carrier SCAC from the MBL / container prefix. CDS "Carrier Name" is the forwarder, not the line. */
export function scacFromMbl(mbl: string): string | undefined {
  const map: Record<string, string> = { ONEY: "ONEY", MEDU: "MEDU", OOLU: "OOLU", COSU: "COSU", YMJA: "YMLU", YMLU: "YMLU", MAEU: "MAEU", HLCU: "HLCU", CMDU: "CMDU", EGLV: "EGLV", HDMU: "HDMU", ZIMU: "ZIMU", ECMU: "CMDU", HAMU: "HLCU" };
  return map[mbl.slice(0, 4).toUpperCase()];
}
export function scacFromContainer(no: string): string | undefined {
  const map: Record<string, string> = { ONEU: "ONEY", OOLU: "OOLU", OOCU: "OOLU", MEDU: "MEDU", MSCU: "MEDU", MSMU: "MEDU", MSBU: "MEDU", MSNU: "MEDU", COSU: "COSU", CSNU: "COSU", CSLU: "COSU", CCLU: "COSU", CBHU: "COSU", YMMU: "YMLU", YMLU: "YMLU", MAEU: "MAEU", MRKU: "MAEU", MRSU: "MAEU", HLCU: "HLCU", HLXU: "HLCU", HAMU: "HLCU", CMAU: "CMDU", ECMU: "CMDU", EGLV: "EGLV", EISU: "EGLV", EITU: "EGLV", HDMU: "HDMU", ZIMU: "ZIMU" };
  return map[no.slice(0, 4).toUpperCase()]; // leased boxes (TGHU, FFAU, UETU, SEGU, TIIU, BSIU…) → undefined → ShipsGo auto-detects
}
