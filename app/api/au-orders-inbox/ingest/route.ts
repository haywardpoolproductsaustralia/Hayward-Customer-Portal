import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { alreadyIngested } from "@/lib/au-orders-inbox";
import type { IngestBody } from "@/lib/au-orders-extract";

export const runtime = "nodejs";
export const maxDuration = 20; // this only writes to Redis now — no Claude, no parsing

/**
 * POST /api/au-orders-inbox/ingest
 *
 * Called by the Power Automate flow on each new email. This now does ONLY the
 * fast part: validate, de-dupe, and queue the raw email onto `soq:pending`.
 * It returns 200 in well under a second, so Power Automate never waits on the
 * slow Claude extraction (that's done by /api/au-orders-inbox/process on a
 * cron). This removes the BadGateway/timeout failures entirely.
 *
 * Auth: shared secret header so only your flow can call it.
 */

const PENDING_KEY = "soq:pending";
// Drop attachments larger than ~4.5MB decoded so the queued job stays within
// Redis value limits. They're noted in the body text so the order is still
// created and a human keys that line from the original email.
const MAX_ATTACH_B64 = 6_000_000;

export async function POST(req: Request) {
  if (req.headers.get("x-ingest-secret") !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body?.internetMessageId || !body?.fromEmail) {
    return NextResponse.json({ error: "missing internetMessageId or fromEmail" }, { status: 400 });
  }

  if (await alreadyIngested(body.internetMessageId)) {
    return NextResponse.json({ ok: true, skipped: "already_ingested" });
  }

  const all = body.attachments ?? [];
  const kept = all.filter((a) => (a.contentBytes?.length ?? 0) <= MAX_ATTACH_B64);
  const oversized = all.filter((a) => (a.contentBytes?.length ?? 0) > MAX_ATTACH_B64);
  const note = oversized.length
    ? `\n\n[Note: ${oversized.length} attachment(s) too large to auto-process and were skipped: ${oversized
        .map((a) => a.name)
        .join(", ")}. Key these lines manually from the original email.]`
    : "";

  const job: IngestBody = { ...body, bodyText: (body.bodyText ?? "") + note, attachments: kept };

  try {
    await redis.rpush(PENDING_KEY, JSON.stringify(job));
  } catch {
    // If the payload is still too large for Redis, queue it without attachments
    // so it still processes (email text only) rather than dropping the order.
    await redis.rpush(
      PENDING_KEY,
      JSON.stringify({
        ...body,
        bodyText: (body.bodyText ?? "") + "\n\n[Note: attachments could not be queued — key lines manually.]",
        attachments: [],
      })
    );
  }

  return NextResponse.json({ ok: true, queued: true });
}
