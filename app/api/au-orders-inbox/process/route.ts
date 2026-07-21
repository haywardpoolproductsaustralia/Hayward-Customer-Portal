import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { processRawIntake, type IngestBody } from "@/lib/au-orders-extract";

export const runtime = "nodejs";
export const maxDuration = 300; // the slow Claude work lives here now; nothing external waits on it

/**
 * GET/POST /api/au-orders-inbox/process
 *
 * The background worker. Runs on a Vercel Cron every minute (see vercel.json),
 * drains a few queued emails from `soq:pending`, and does the Claude extraction
 * + customer/SKU resolution + createIntake for each. Failures go to
 * `soq:failed` so nothing is silently lost and can be inspected/re-queued.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically
 * when CRON_SECRET is set as an env var. A manual trigger with the ingest
 * secret header also works.
 */

const PENDING_KEY = "soq:pending";
const FAILED_KEY = "soq:failed";
const BATCH = 3; // process a few per run; cron fires every minute so the queue drains fast

function authorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (req.headers.get("x-ingest-secret") === process.env.INGEST_SECRET) return true;
  return false;
}

async function drain() {
  const results: unknown[] = [];
  for (let i = 0; i < BATCH; i++) {
    const raw = await redis.lpop<string | IngestBody>(PENDING_KEY);
    if (raw == null) break;

    let job: IngestBody;
    try {
      job = typeof raw === "string" ? (JSON.parse(raw) as IngestBody) : (raw as IngestBody);
    } catch {
      await redis.rpush(FAILED_KEY, typeof raw === "string" ? raw : JSON.stringify(raw));
      results.push({ ok: false, error: "bad_job_json" });
      continue;
    }

    try {
      const r = await processRawIntake(job);
      if (!r.ok) {
        await redis.rpush(FAILED_KEY, JSON.stringify({ id: job.internetMessageId, error: r.error }));
      }
      results.push(r);
    } catch (e) {
      await redis.rpush(FAILED_KEY, JSON.stringify({ id: job.internetMessageId, error: String(e) }));
      results.push({ ok: false, error: String(e) });
    }
  }
  return results;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await drain();
  return NextResponse.json({ ok: true, processed: results.length, results });
}

export async function POST(req: Request) {
  return GET(req);
}
