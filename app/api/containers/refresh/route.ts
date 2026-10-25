// app/api/containers/refresh/route.ts
// GET  — Vercel cron (vercel.json: "0 */2 * * *"): pull the ShipsGo account and record ETA/status changes.
// POST — the "Refresh tracking" button on the Purchasing page (staff), same work, optional ?force=1 and ?register=1
//        (register = put every eligible known container on ShipsGo now — see lib/containers/tracking.ts rules).
// Cron auth: Authorization: Bearer <CRON_SECRET> (Vercel adds it) or x-ingest-secret.

import { NextRequest, NextResponse } from "next/server";
import { getCustomerAccess } from "@/lib/access";
import { redis } from "@/lib/redis";
import { getIndex, K } from "@/lib/containers/store";
import { registerNew, syncFromShipsgo } from "@/lib/containers/tracking";

export const runtime = "nodejs";
export const maxDuration = 300;

function cronAuthorized(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (req.headers.get("x-ingest-secret") === process.env.INGEST_SECRET) return true;
  return false;
}

async function run(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const register = req.nextUrl.searchParams.get("register") === "1";
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const registration = register ? await registerNew(await getIndex(), dry) : null;
  const sync = await syncFromShipsgo({ force });
  const summary = { ...sync, registration: registration ? { planned: registration.plan.length, skipped: registration.skipped.length, ok: registration.results.filter((r) => r.ok).length, failed: registration.results.filter((r) => !r.ok).length } : null };
  await redis.set(K.refresh, JSON.stringify(summary));
  return NextResponse.json({ ok: true, ...sync, registration });
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(req);
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    const access = await getCustomerAccess();
    if (!access?.isAggregate) return NextResponse.json({ error: "Internal staff only" }, { status: 403 });
  }
  return run(req);
}
