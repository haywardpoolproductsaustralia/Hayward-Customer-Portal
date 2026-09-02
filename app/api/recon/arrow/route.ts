// app/api/recon/arrow/route.ts
// Returns Arrow open PO lines from Redis for the reconciliation page.
// Data is written by arrow-recon.js running on AZ-Grey.
// Redis keys: recon:arrow_open_pos  recon:arrow_meta
//
// UPDATED: Filter by stock category
// - Hayward staff (isAggregate): see ALL POs
// - Poolwater Products: see ONLY Paramount stock (STOCK_CATEGORY = 'PR')

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getCustomerAccess, PARAMOUNT_CATEGORY } from '@/lib/access';

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
      ? (typeof rawLines === 'string' ? JSON.parse(rawLines)
