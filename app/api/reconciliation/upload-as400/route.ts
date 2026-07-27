import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { redis } from "@/lib/redis";
import { getCustomerAccess } from "@/lib/access";
import type { As400Row } from "@/lib/recon/reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/reconciliation/upload-as400   (multipart/form-data, field "file")
 *
 * Manual stand-in for the Snowflake feed until the service account exists.
 * Accepts the CSV/XLSX exported from Snowsight and writes recon:as400_orders.
 *
 * Tolerates both the aggregated query output and the raw un-aggregated one:
 * rows are always re-aggregated to the PO + SKU grain here, because the raw
 * feed repeats PO+ITEM across several sales-order lines and joining on a
 * non-unique key double-counts quantities.
 *
 * Recognised columns (case-insensitive, first match wins):
 *   PO      PO_NUMBER | CUSTOMER_PURCHASE_ORDER_REF
 *   SKU     AS400_CODE | ITEM_REF
 *   ordered AS400_ORDERED_QTY | QUANTITY_ORDERED
 *   shipped AS400_SHIPPED_QTY | QUANTITY_SHIPPED
 *   promise PROMISE_DATE | ETA
 *   cancel  ANY_CANCELLED | IS_CANCELLED
 *   so      US_SALES_ORDER | ORDER_REF
 *   loc     LOCATION | INVENTORY_SITE_REF
 */

const pick = (row: Record<string, unknown>, names: string[]) => {
  for (const n of names) {
    for (const k of Object.keys(row)) {
      if (k.trim().toUpperCase() === n) return row[k];
    }
  }
  return undefined;
};

const num = (v: unknown) => {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
};

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const truthy = (v: unknown) => {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "Y" || s === "YES";
};

export async function POST(req: Request) {
  const access = await getCustomerAccess();
  if (!access) return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  if (!access.isAggregate) {
    return NextResponse.json({ error: "Internal staff only" }, { status: 403 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a 'file' field" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "No file supplied" }, { status: 400 });

  let raw: Record<string, unknown>[];
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true, raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  } catch (e) {
    return NextResponse.json({ error: `Could not read the file: ${(e as Error).message}` }, { status: 422 });
  }
  if (!raw.length) return NextResponse.json({ error: "The file has no rows" }, { status: 422 });

  // aggregate to PO + SKU
  const acc = new Map<string, As400Row & { _lines: number }>();
  let skipped = 0;
  for (const r of raw) {
    const po = String(pick(r, ["PO_NUMBER", "CUSTOMER_PURCHASE_ORDER_REF"]) ?? "").trim();
    const sku = String(pick(r, ["AS400_CODE", "ITEM_REF"]) ?? "").trim();
    if (!po || !sku || !/^\d{6}$/.test(po)) { skipped++; continue; }

    const cancelled = truthy(pick(r, ["ANY_CANCELLED", "IS_CANCELLED"]));
    const ordered = num(pick(r, ["AS400_ORDERED_QTY", "QUANTITY_ORDERED"]));
    const shipped = num(pick(r, ["AS400_SHIPPED_QTY", "QUANTITY_SHIPPED"]));
    const promise = iso(pick(r, ["PROMISE_DATE", "ETA"]));
    const so = pick(r, ["US_SALES_ORDER", "ORDER_REF"]);
    const loc = pick(r, ["LOCATION", "INVENTORY_SITE_REF"]);

    const key = `${po}\u0000${sku}`;
    const cur = acc.get(key);
    if (!cur) {
      acc.set(key, {
        poNumber: po, as400Code: sku,
        orderedQty: cancelled ? 0 : ordered,
        shippedQty: shipped,
        promiseDate: promise,
        anyCancelled: cancelled,
        usSalesOrder: so ? String(so).trim() : null,
        location: loc ? String(loc).trim() : null,
        _lines: 1,
      });
    } else {
      if (!cancelled) cur.orderedQty += ordered;
      cur.shippedQty += shipped;
      if (promise && (!cur.promiseDate || promise < cur.promiseDate)) cur.promiseDate = promise;
      if (cancelled) cur.anyCancelled = true;
      cur._lines++;
    }
  }

  const rows: As400Row[] = [...acc.values()].map(({ _lines, ...keep }) => keep);
  if (!rows.length) {
    return NextResponse.json(
      { error: "No usable rows. Expected a PO column (6-digit) and an item column." },
      { status: 422 }
    );
  }

  await redis.set("recon:as400_orders", JSON.stringify(rows));
  await redis.set("recon:as400_meta", JSON.stringify({
    uploadedAt: new Date().toISOString(),
    file: file.name,
    inputRows: raw.length,
    rows: rows.length,
    pos: new Set(rows.map((r) => r.poNumber)).size,
    skipped,
  }));

  return NextResponse.json({
    ok: true, inputRows: raw.length, rows: rows.length,
    pos: new Set(rows.map((r) => r.poNumber)).size, skipped,
  });
}
