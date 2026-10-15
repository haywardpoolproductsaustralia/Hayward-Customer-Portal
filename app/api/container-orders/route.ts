// app/api/container-orders/route.ts
// Direct container orders (SO -> PO -> container) for the staff-only
// /dashboard/container-orders page. All data comes from Redis - see
// lib/container-orders.ts for the keys and the merge with CDS-Net shipments.

import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getContainerOrders } from '@/lib/container-orders';

export const dynamic = 'force-dynamic';

export async function GET() {
  const access = await getCustomerAccess();
  if (!access?.isAggregate) {
    return NextResponse.json({ error: 'Unauthorized: Hayward staff only' }, { status: 403 });
  }

  try {
    const payload = await getContainerOrders();
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Failed to load container orders' }, { status: 500 });
  }
}
