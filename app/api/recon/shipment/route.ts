// app/api/recon/shipment/route.ts
// Returns CDS-Net shipment lines from Redis for the reconciliation page.
// Data is written by either:
//   - shipment-load.js on AZ-Grey (manual)
//   - /api/recon/shipment-upload (browser upload)
// Redis keys: recon:shipment_index  recon:shipment_meta

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET() {
  try {
    const [rawLines, rawMeta] = await Promise.all([
      redis.get('recon:shipment_index'),
      redis.get('recon:shipment_meta'),
    ]);

    const lines = rawLines
      ? (typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines)
      : [];

    const meta = rawMeta
      ? (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta)
      : { receivedAt: null, rows: 0, filename: null, subject: null };

    return NextResponse.json({
      lines,
      receivedAt: (meta as any).receivedAt ?? null,
      rows: Array.isArray(lines) ? lines.length : 0,
      filename: (meta as any).filename ?? (meta as any).file ?? null,
      subject: (meta as any).subject ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ lines: [], error: e.message }, { status: 500 });
  }
}
