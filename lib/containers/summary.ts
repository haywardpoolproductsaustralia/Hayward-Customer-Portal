// lib/containers/summary.ts
// Server-side one-liners about a container record, for pages other than Purchasing (Container orders, exports).
// Mirrors the status chain the Purchasing page uses in components/ContainerTracking.tsx:
//   ShipsGo container status → Century → C.H. Robinson → CDS → Dimi's schedule.

import type { ContainerRecord } from "./types";

const STATUS_LABEL: Record<string, string> = {
  EMPTY_SHIPPER: "Empty to shipper", GATE_IN: "At origin terminal", LOADED: "Loaded", SAILING: "Sailing", ARRIVED: "Arrived", DISCHARGED: "Discharged",
  GATE_OUT: "Collected", EMPTY_RETURN: "Empty returned", UNKNOWN: "Unknown", NEW: "Registered", INPROGRESS: "Looking up", BOOKED: "Booked", UNTRACKED: "Untracked",
};
const DONE = new Set(["GATE_OUT", "EMPTY_RETURN"]);

export interface ContainerTrack {
  containerNo: string;
  status: string;                     // human label
  tone: "done" | "live" | "doc" | "wait";
  closed: boolean;                    // collected / returned / delivered
  eta: string | null;                 // best current ETA
  etaInitial: string | null;
  vessel: string | null;
  pol: string | null; pod: string | null;
  mapUrl: string | null;
  sources: string[];
  pos: string[];
  direct: boolean;                    // believed to be going straight to a customer site
  directWhy: string | null;
  forecast?: { customer: string; so?: string; notes?: string; value?: number; updatedEta?: string; delivered: boolean };
  updatedAt: string;
}

export const bestEta = (c: ContainerRecord) => c.live?.eta ?? c.century?.currentEta ?? c.chr?.eta ?? c.eta ?? c.schedule?.eta ?? c.forecast?.updatedEta ?? null;

export function statusOf(c: ContainerRecord): { label: string; tone: ContainerTrack["tone"]; closed: boolean } {
  const s = c.live?.containerStatus;
  if ((s && DONE.has(s)) || c.deliveredDate) return { label: s && DONE.has(s) ? STATUS_LABEL[s] : `Delivered ${c.deliveredDate}`, tone: "done", closed: true };
  if (s && s !== "UNKNOWN") return { label: STATUS_LABEL[s] ?? s, tone: "live", closed: false };
  const pending = !c.live?.shipmentStatus || ["NEW", "INPROGRESS", "UNTRACKED"].includes(c.live.shipmentStatus);
  if (c.live?.shipmentStatus && !pending) return { label: STATUS_LABEL[c.live.shipmentStatus] ?? c.live.shipmentStatus, tone: "live", closed: false };
  const cs = c.century?.status;
  if (cs && DONE.has(cs)) return { label: `${STATUS_LABEL[cs]} ${c.century?.eventAt ?? ""}`.trim(), tone: "done", closed: true };
  if (cs) return { label: `${STATUS_LABEL[cs] ?? c.century?.event} (Century)`, tone: "live", closed: false };
  const hs = c.chr?.status;
  if (hs && DONE.has(hs)) return { label: `${STATUS_LABEL[hs]} ${c.chr?.deliveredAt ?? c.chr?.ata ?? ""}`.trim(), tone: "done", closed: true };
  if (hs) return { label: `${STATUS_LABEL[hs] ?? c.chr?.statusRaw} (CHR)`, tone: "live", closed: false };
  if (c.forecast?.delivered) return { label: "Delivered (per forecast sheet)", tone: "done", closed: true };
  if (c.live?.shipmentStatus) return { label: STATUS_LABEL[c.live.shipmentStatus] ?? c.live.shipmentStatus, tone: "wait", closed: false };
  if ((c.eta || c.vessel) && c.sources.includes("cds")) return { label: "On water (CDS)", tone: "doc", closed: false };
  if (c.eta || c.schedule?.eta) return { label: "On water (Dimi's schedule)", tone: "doc", closed: false };
  return { label: "Shipped — awaiting vessel", tone: "wait", closed: false };
}

/** Is this box going straight to a customer? Any of: the forecast sheet lists it, the ShipsGo reference / tags say
 *  "direct", or it discharges somewhere other than Melbourne (our warehouse) while every Hayward box lands there. */
export function directOf(c: ContainerRecord, directPos: Set<string>): { direct: boolean; why: string | null } {
  if (c.forecast) return { direct: true, why: `On the Wuxi Shipment Forecast for ${c.forecast.customer}` };
  const ref = `${c.live?.reference ?? ""}`;
  if (/direct/i.test(ref)) return { direct: true, why: `ShipsGo reference “${ref.slice(0, 60)}”` };
  const hit = c.pos.find((p) => directPos.has(p));
  if (hit) return { direct: true, why: `PO ${hit} is addressed to a customer site in Arrow` };
  const pod = (c.live?.pod ?? c.destPort ?? "").toUpperCase();
  if (pod && !/MELBOURNE|MEL\b|AUMEL/.test(pod) && /BRISBANE|SYDNEY|FREMANTLE|ADELAIDE|AUCKLAND|TAURANGA|BNE|SYD|FRE|ADL|AKL/.test(pod)) return { direct: true, why: `Discharges at ${pod}, not Melbourne` };
  return { direct: false, why: null };
}

export function trackOf(c: ContainerRecord, directPos: Set<string> = new Set()): ContainerTrack {
  const s = statusOf(c);
  const d = directOf(c, directPos);
  return {
    containerNo: c.containerNo, status: s.label, tone: s.tone, closed: s.closed,
    eta: bestEta(c), etaInitial: c.live?.etaInitial ?? null,
    vessel: c.live?.vessel ?? c.vessel ?? null, pol: c.live?.pol ?? c.originPort ?? null, pod: c.live?.pod ?? c.destPort ?? null,
    mapUrl: c.live?.mapUrl ?? null, sources: c.sources, pos: c.pos, direct: d.direct, directWhy: d.why,
    forecast: c.forecast ? { customer: c.forecast.customer, so: c.forecast.so, notes: c.forecast.notes, value: c.forecast.value, updatedEta: c.forecast.updatedEta, delivered: c.forecast.delivered } : undefined,
    updatedAt: c.live?.updatedAt ?? c.lastSeen,
  };
}
