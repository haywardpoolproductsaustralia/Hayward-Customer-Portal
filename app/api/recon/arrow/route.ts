// app/api/recon/arrow/route.ts
// Returns Arrow open PO lines from Redis for the reconciliation page.
// Data is written by arrow-recon.js running on AZ-Grey.
// Redis keys: recon:arrow_open_pos  recon:arrow_meta
//
// UPDATED: Filters lines by customer access.
// - Hayward staff (isAggregate): see ALL open POs
// - Poolwater Products + other customers: see ONLY their own customer codes

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getCustomerAccess } from '@/lib/access';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

interface ArrowLine {
  po: string;
  line: number;
  arrowStock: string;
  supplierSku: string;
  description: string | null;
  stockCategory: string;
  creditor: string | null;
  customerCode: string | null;  // **NEW**
  qtyOrdered: number;
  qtyReceived: number;
  qtyOutstanding: number;
  orderDate: string | null;
  requestedDate: string | null;
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access?.canAccessReconciliation) {
    return NextResponse.json(
      { error: 'Unauthorized: reconciliation access required' },
      { status: 403 }
    );
  }

  try {
    const [rawLines, rawMeta] = await Promise.all([
      redis.get('recon:arrow_open_pos'),
      redis.get('recon:arrow_meta'),
    ]);

    let lines = rawLines
      ? (typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines)
      : [];

    // Filter by customer access:
    // - Hayward staff (isAggregate): see all POs
    // - Others: see only their own customer codes
    if (!access.isAggregate && Array.isArray(lines)) {
      const allowedCodes = new Set(access.customerCodes);
      lines = (lines as ArrowLine[]).filter((line) =>
        allowedCodes.has(line.customerCode ?? '')
      );
    }

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
