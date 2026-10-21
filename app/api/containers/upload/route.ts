// app/api/containers/upload/route.ts
// POST multipart — staff drop container documents straight onto the Purchasing page:
//   .pdf  (US invoice MFX-…_INVOICE_FT.PDF, Wuxi packing slip R#######.PDF)
//   .xlsx (CDS "Shipment Activity by Container")
//   .msg  (the whole Outlook email saved from Dimi's mailbox — attachments are unpacked here)
// Field name "files" (repeatable). Same parsing path as the mailbox flow.

import { NextRequest, NextResponse } from "next/server";
import { getCustomerAccess } from "@/lib/access";
import { redis } from "@/lib/redis";
import { emailFromFile, emailFromMsg, ingestEmail, isContainerEmail } from "@/lib/containers/ingest";
import { K } from "@/lib/containers/store";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  if (!access.isAggregate) return NextResponse.json({ error: "Internal staff only" }, { status: 403 });

  let files: File[] = [];
  try {
    const form = await req.formData();
    files = form.getAll("files").filter((f): f is File => f instanceof File);
    const single = form.get("file");
    if (single instanceof File) files.push(single);
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with 'files'" }, { status: 400 });
  }
  if (!files.length) return NextResponse.json({ error: "No files supplied" }, { status: 400 });

  const register = req.nextUrl.searchParams.get("register") === "1" || process.env.CT_AUTO_REGISTER === "true";
  const results: any[] = [];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    try {
      const email = /\.msg$/i.test(f.name) ? await emailFromMsg(buf, f.name) : emailFromFile(f.name, buf);
      if (!isContainerEmail(email)) { results.push({ file: f.name, skipped: "not a container document", from: email.from, subject: email.subject }); continue; }
      if (email.messageId) {
        const fresh = await redis.set(K.seen(email.messageId), email.receivedDateTime, { nx: true, ex: 60 * 60 * 24 * 90 });
        if (fresh !== "OK") { results.push({ file: f.name, skipped: "already ingested (same Message-ID)", subject: email.subject }); continue; }
      }
      const r = await ingestEmail(email, { register });
      results.push({ file: f.name, subject: email.subject, from: email.from, ...r });
    } catch (e: any) {
      results.push({ file: f.name, error: e?.message ?? String(e) });
    }
  }
  return NextResponse.json({ ok: true, results });
}
