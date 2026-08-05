// app/api/recon/arrow/route.ts
// Returns Arrow open PO lines from Redis for the reconciliation page.
// Data is written by arrow-recon.js running on AZ-Grey.
// Redis keys: recon:arrow_open_pos  recon:arrow_meta

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET() {
  try {
    const [rawLines, rawMeta] = await Promise.all([
      redis.get('recon:arrow_open_pos'),
      redis.get('recon:arrow_meta'),
    ]);

    const lines = rawLines
      ? (typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines)
      : [];

    const meta = rawMeta
      ? (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta)
      : { generatedAt: null, rows: 0 };

    return NextResponse.json({
      lines,
      generatedAt: (meta as any).generatedAt ?? null,
      rows: Array.isArray(lines) ? lines.length : 0,
    });
  } catch (e: any) {
    return NextResponse.json({ lines: [], error: e.message }, { status: 500 });
  }
}
