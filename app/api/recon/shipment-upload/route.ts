// app/api/recon/shipment-upload/route.ts
// Receives parsed CDS-Net "Shipment Activity by Container" lines from the
// browser upload and writes them to Redis in the same shape as the
// Power Automate → /api/shipment-inbox/ingest route.
// Keys: recon:shipment_index  recon:shipment_meta

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { lines, receivedAt, rows, filename } = body;

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: 'No lines provided' }, { status: 400 });
    }

    await redis.set('recon:shipment_index', JSON.stringify(lines));
    await redis.set('recon:shipment_meta', JSON.stringify({
      receivedAt: receivedAt ?? new Date().toISOString(),
      rows: rows ?? lines.length,
      filename: filename ?? null,
      subject: `browser upload (${filename ?? 'unknown'})`,
    }));

    return NextResponse.json({ ok: true, rows: lines.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
