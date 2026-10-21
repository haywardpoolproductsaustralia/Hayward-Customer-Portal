// app/api/containers/ingest/route.ts
// POST — fed by the Power Automate flow on the AU Containers shared mailbox (au-containers@hayward.com).
// Same contract and secret as /api/au-orders-inbox/ingest, so the flow is a clone of that one:
//   headers: x-ingest-secret: <INGEST_SECRET>
//   body:    { internetMessageId, subject, fromEmail, receivedDateTime, attachments: [{ name, contentType, contentBytes }] }
// Parsing is fast (no LLM), so this processes inline rather than queueing.

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { ingestEmail, isContainerEmail, type InboundEmail } from "@/lib/containers/ingest";
import { K } from "@/lib/containers/store";

export const runtime = "nodejs";
export const maxDuration = 120; // CDS xlsx is ~1.8 MB; parse + a few ShipsGo calls

const SEEN_TTL = 60 * 60 * 24 * 90;
const autoRegister = () => process.env.CT_AUTO_REGISTER === "true";

export async function POST(req: NextRequest) {
  if (req.headers.get("x-ingest-secret") !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  const msg: InboundEmail = {
    from: String(body.fromEmail ?? body.from ?? ""),
    subject: String(body.subject ?? ""),
    receivedDateTime: String(body.receivedDateTime ?? new Date().toISOString()),
    messageId: body.internetMessageId ? String(body.internetMessageId) : undefined,
    attachments: (Array.isArray(body.attachments) ? body.attachments : [])
      .filter((a: any) => a?.name && a?.contentBytes)
      .map((a: any) => ({ name: String(a.name), contentType: a.contentType ? String(a.contentType) : undefined, content: Buffer.from(String(a.contentBytes), "base64") })),
  };
  if (!isContainerEmail(msg)) return NextResponse.json({ ok: true, skipped: "not_container_email", subject: msg.subject });

  const id = (msg.messageId ?? "").trim();
  if (id) {
    const fresh = await redis.set(K.seen(id), msg.receivedDateTime, { nx: true, ex: SEEN_TTL });
    if (fresh !== "OK") return NextResponse.json({ ok: true, skipped: "already_ingested", internetMessageId: id });
  }
  try {
    const result = await ingestEmail(msg, { register: autoRegister() });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    if (id) await redis.del(K.seen(id)); // let the flow's retry try again
    await redis.lpush(K.failed, JSON.stringify({ id, subject: msg.subject, from: msg.from, error: e?.message, at: new Date().toISOString() }));
    await redis.ltrim(K.failed, 0, 99);
    return NextResponse.json({ error: e?.message ?? "ingest failed" }, { status: 500 });
  }
}
