import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { parseShipmentWorkbook } from "@/lib/recon/shipmentIngest";

export const runtime = "nodejs";
export const maxDuration = 60; // parse a ~2MB workbook, then write Redis

/**
 * POST /api/shipment-inbox/ingest
 *
 * Called by a Power Automate flow that watches jtatapudi@hayward.com for emails
 * from NoReply@cds-net.com with the "Shipment Activity by Container" attachment.
 * Mirrors /api/au-orders-inbox/ingest: same x-ingest-secret auth, same base64
 * attachment shape. Parses the workbook, keeps AU/NZ lines, and writes:
 *   recon:shipment_index  ShipmentLine[]
 *   recon:shipment_meta    { receivedAt, subject, rows, file }
 *
 * One file replaces the last, so the page always sees the latest report.
 */

interface IncomingAttachment { name: string; contentType?: string; contentBytes: string }
interface Body {
  subject?: string;
  receivedDateTime?: string;
  attachments?: IncomingAttachment[];
}

const isShipmentFile = (name: string) =>
  /shipment\s*activity\s*by\s*container/i.test(name) && /\.xlsx?$/i.test(name);

export async function POST(req: Request) {
  if (req.headers.get("x-ingest-secret") !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const att = (body.attachments ?? []).find((a) => isShipmentFile(a.name));
  if (!att?.contentBytes) {
    return NextResponse.json({ error: "no Shipment Activity by Container attachment" }, { status: 400 });
  }

  let lines;
  try {
    lines = parseShipmentWorkbook(Buffer.from(att.contentBytes, "base64"));
  } catch (e) {
    return NextResponse.json({ error: `parse_failed: ${String((e as Error).message)}` }, { status: 422 });
  }

  await redis.set("recon:shipment_index", JSON.stringify(lines));
  await redis.set(
    "recon:shipment_meta",
    JSON.stringify({
      receivedAt: body.receivedDateTime ?? new Date().toISOString(),
      subject: body.subject ?? null,
      rows: lines.length,
      file: att.name,
    })
  );

  return NextResponse.json({ ok: true, rows: lines.length });
}
