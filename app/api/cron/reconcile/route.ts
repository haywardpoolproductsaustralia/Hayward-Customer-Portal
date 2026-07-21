/* app/api/cron/reconcile/route.ts
   Scheduled job: pull all three sources, reconcile, persist to Redis.
   Triggered by Vercel Cron (see vercel.json). Also callable manually with the
   CRON_SECRET bearer token for testing.
*/

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getArrowOpenPos, getAs400Orders } from "@/lib/recon/queries";
import { fetchLatestShipmentIndex } from "@/lib/recon/shipmentIngest";
import { getGraphAppToken } from "@/lib/recon/graphToken";
import { buildAs400Index, reconcile, summarize } from "@/lib/recon/reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds; reconciliation + Graph can be slow

const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / _TOKEN

export async function GET(req: Request) {
  // auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  try {
    // 1. pull the three sources (Arrow + AS400 in parallel, then the mailbox)
    const [arrow, as400Rows] = await Promise.all([getArrowOpenPos(), getAs400Orders()]);
    const { index: shipIdx, receivedAt, subject } = await fetchLatestShipmentIndex({
      mailbox: process.env.RECON_MAILBOX!,
      getToken: getGraphAppToken,
    });

    // 2. reconcile
    const lines = reconcile(arrow, buildAs400Index(as400Rows), shipIdx);
    const summary = summarize(lines);

    // 3. persist for the page
    const payload = {
      lines, summary,
      meta: {
        generatedAt: new Date().toISOString(),
        shipmentReceivedAt: receivedAt,
        shipmentSubject: subject,
        arrowLines: arrow.length,
        as400Rows: as400Rows.length,
      },
    };
    await redis.set("recon:latest", payload);

    return NextResponse.json({ ok: true, startedAt, ...summary, generatedAt: payload.meta.generatedAt });
  } catch (err: any) {
    // keep the last good snapshot in place; just report the failure
    await redis.set("recon:lastError", { at: new Date().toISOString(), message: String(err?.message ?? err) });
    return NextResponse.json({ ok: false, startedAt, error: String(err?.message ?? err) }, { status: 500 });
  }
}
