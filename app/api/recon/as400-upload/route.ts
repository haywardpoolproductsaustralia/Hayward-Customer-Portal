// app/api/recon/as400-upload/route.ts
// Receives the parsed AS400 lines from the reconciliation page upload
// and writes them to Redis as recon:as400_lines + recon:as400_meta.

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { lines, filename, uploadedAt } = body;

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: 'No lines provided' }, { status: 400 });
    }

    await redis.set('recon:as400_lines', JSON.stringify(lines));
    await redis.set('recon:as400_meta', JSON.stringify({
      uploadedAt: uploadedAt ?? new Date().toISOString(),
      rows: lines.length,
      filename: filename ?? null,
    }));

    return NextResponse.json({ ok: true, rows: lines.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
