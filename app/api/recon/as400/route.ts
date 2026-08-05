// app/api/recon/as400/route.ts
// Returns the stored AS400 lines from Redis for the reconciliation page.

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET() {
  try {
    const [rawLines, rawMeta] = await Promise.all([
      redis.get('recon:as400_lines'),
      redis.get('recon:as400_meta'),
    ]);

    const lines = rawLines
      ? (typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines)
      : [];
    const meta = rawMeta
      ? (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta)
      : { uploadedAt: null, rows: 0, filename: null };

    return NextResponse.json({ lines, ...meta });
  } catch (e: any) {
    return NextResponse.json({ lines: [], error: e.message }, { status: 500 });
  }
}
