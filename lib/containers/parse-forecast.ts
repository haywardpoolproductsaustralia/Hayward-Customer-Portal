// lib/containers/parse-forecast.ts
// Purchasing's "Wuxi Shipment Forecast.xlsx" (SharePoint) — the hand-kept list of CUSTOMER-DIRECT containers.
// Sheet1 header: CUSTOMER | CUSTOMER PO # | Hayward Packing Slip (= Arrow SO number) | DSM | PO NUMBER # (WUXI) |
//   COMING FROM | SHIPPING INFO (container number(s) or free text) | VALUE $ | MARGIN% | ORIGINAL DELIVERY ETA |
//   UPDATED DELIVERY ETA | NOTES | DELIVERED
// "Container Info" sheet: Customer | Container Number | Items ("27 x PES22CSTA, 54 x W3HSCTRACCA" or "SFP3010DI X 72").
//
// What it adds: the customer and Arrow SO per container (so the Container orders page can link PO ↔ SO and show the
// delivery address), the direct-to-customer flag, and an item list for boxes no other feed describes.

import * as XLSX from "xlsx";
import type { ContainerLine, ContainerRecord, ForecastInfo, ParseResult } from "./types";
import { ISO6346 } from "./types";

const S = (v: unknown) => (v == null ? "" : String(v).replace(/ /g, " ").trim());
const N = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) && String(v ?? "").trim() !== "" ? n : undefined; };
function date(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10); // local calendar day, not UTC
  const s = S(v); if (!s) return undefined;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return s.slice(0, 10);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return undefined;
}
const containersIn = (text: string) => [...new Set((text.toUpperCase().match(/[A-Z]{4}\s?\d{7}/g) ?? []).map((c) => c.replace(/\s/g, "")).filter((c) => ISO6346.test(c)))];

export function isForecastWorkbook(nameOrHeader: string): boolean {
  return /shipment\s*forecast/i.test(nameOrHeader) || /PO NUMBER #\s*\(WUXI\)/i.test(nameOrHeader);
}

/** "27 x PES22CSTA, 54 x W3HSCTRACCA" / "SFP3010DI X 72" → [{item, qty}] */
export function parseItemList(text: string): Array<{ item: string; qty: number }> {
  const out: Array<{ item: string; qty: number }> = [];
  for (const part of text.split(/[,.;]\s+|,|\n/).map((p) => p.trim()).filter(Boolean)) {
    let m = /^(\d+)\s*[xX×]\s*([A-Za-z0-9\-\/]+)$/.exec(part);
    if (m) { out.push({ item: m[2].toUpperCase(), qty: Number(m[1]) }); continue; }
    m = /^([A-Za-z0-9\-\/]+)\s*[xX×]\s*(\d+)$/.exec(part);
    if (m) out.push({ item: m[1].toUpperCase(), qty: Number(m[2]) });
  }
  return out;
}

export interface ForecastParse extends ParseResult {
  /** PO → Arrow SO number as keyed in the "Hayward Packing Slip" column (feeds container:links). */
  links: Record<string, string>;
  rows: number;
}

export function parseForecastWorkbook(buf: Buffer, observedAt: string): ForecastParse {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const warnings: string[] = [];
  const links: Record<string, string> = {};
  const byContainer = new Map<string, Partial<ContainerRecord>>();
  const poOfContainer = new Map<string, Set<string>>();
  let rows = 0;

  // ---- main sheet: the first sheet whose header row has the Wuxi PO column
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const hi = aoa.findIndex((r) => r.some((c) => /PO NUMBER/i.test(S(c)) && /WUXI/i.test(S(c))));
    if (hi < 0) continue;
    const hdr = aoa[hi].map((c) => S(c).toUpperCase());
    const col = (re: RegExp) => hdr.findIndex((h) => re.test(h));
    const C = { customer: col(/^CUSTOMER\s*$/), custPo: col(/CUSTOMER PO/), so: col(/PACKING SLIP/), dsm: col(/^DSM/), po: col(/PO NUMBER/), from: col(/COMING FROM/), ship: col(/SHIPPING INFO/), value: col(/VALUE/), oEta: col(/ORIGINAL/), uEta: col(/UPDATED/), notes: col(/NOTES/), delivered: col(/DELIVERED/) };
    for (const r of aoa.slice(hi + 1)) {
      const customer = S(r[C.customer]);
      const po = (S(r[C.po]).match(/\b(9\d{5})\b/) ?? [])[1];
      if (!customer && !po) continue;
      rows++;
      const so = (S(r[C.so]).match(/\b(\d{6})\b/) ?? [])[1];
      if (po && so) links[po] = so;
      const shipText = S(r[C.ship]);
      const nos = containersIn(shipText);
      const info: ForecastInfo = {
        customer, customerPo: S(r[C.custPo]) || undefined, so, dsm: S(r[C.dsm]) || undefined, origin: S(r[C.from]) || undefined,
        shippingInfo: nos.length ? undefined : shipText || undefined, value: N(r[C.value]),
        originalEta: date(r[C.oEta]), updatedEta: date(r[C.uEta]), notes: S(r[C.notes]) || undefined,
        delivered: r[C.delivered] === true || /^(true|yes|y|1)$/i.test(S(r[C.delivered])), updatedAt: observedAt,
      };
      for (const no of nos) {
        const prev = byContainer.get(no);
        const pos = new Set([...(prev?.pos ?? []), ...(po ? [po] : [])]);
        byContainer.set(no, {
          containerNo: no, pos: [...pos], sources: ["forecast"], firstSeen: observedAt, lastSeen: observedAt,
          originPort: prev?.originPort ?? (/wuxi|china/i.test(info.origin ?? "") ? "WUXI" : /^us$/i.test(info.origin ?? "") ? "US" : undefined),
          forecast: prev?.forecast ? { ...prev.forecast, notes: [prev.forecast.notes, info.notes].filter(Boolean).join(" · ") || undefined, value: (prev.forecast.value ?? 0) + (info.value ?? 0) || prev.forecast.value } : info,
        });
        if (po) (poOfContainer.get(no) ?? poOfContainer.set(no, new Set()).get(no)!).add(po);
      }
    }
    break;
  }

  // ---- "Container Info": items per container → lines, when the box maps to exactly one PO
  const lines: ContainerLine[] = [];
  const infoSheet = wb.SheetNames.find((n) => /container\s*info/i.test(n));
  if (infoSheet) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[infoSheet], { header: 1, raw: true, defval: null });
    const hi = aoa.findIndex((r) => r.some((c) => /container number/i.test(S(c))));
    const hdr = hi >= 0 ? aoa[hi].map((c) => S(c).toUpperCase()) : [];
    const cNo = Math.max(0, hdr.findIndex((h) => /CONTAINER/.test(h))), cItems = Math.max(1, hdr.findIndex((h) => /ITEMS/.test(h)));
    for (const r of aoa.slice(hi + 1)) {
      const no = containersIn(S(r[cNo]))[0];
      if (!no) continue;
      const items = parseItemList(S(r[cItems]));
      const pos = [...(poOfContainer.get(no) ?? [])];
      if (!items.length) continue;
      if (pos.length !== 1) { warnings.push(`Forecast: ${no} lists ${items.length} items but maps to ${pos.length} POs — items not attached`); continue; }
      const rec = byContainer.get(no)!;
      rec.lines = items.map((it) => ({ po: pos[0], supplierItem: it.item, qty: it.qty, source: "forecast" as const, sourceRef: "Wuxi Shipment Forecast", observedAt }));
      lines.push(...rec.lines);
    }
  }

  warnings.push(`Forecast: ${rows} rows, ${byContainer.size} containers, ${Object.keys(links).length} PO→SO links, ${lines.length} item lines`);
  return { lines, containers: [...byContainer.values()], warnings, links, rows };
}
