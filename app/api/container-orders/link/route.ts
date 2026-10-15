// app/api/container-orders/link/route.ts
// Pin (POST) or unpin (DELETE) a manual SO <-> PO link. Links live in Redis
// key container:links as { "<po>": "<so>" } and are applied by
// sync-container-orders.js on its next run (every 15 min on AZ-Grey), which
// is when the page shows the SO's customer, address and lines. The page
// shows the pin immediately so staff know it has been taken.

import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { getCustomerAccess } from '@/lib/access';
import { CONTAINER_LINKS_KEY, loadContainerLinks } from '@/lib/container-orders';

export const dynamic = 'force-dynamic';

const SIX_DIGITS = /^\d{6}$/;

async function staffOnly() {
  const access = await getCustomerAccess();
  return access?.isAggregate ? null : NextResponse.json({ error: 'Unauthorized: Hayward staff only' }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const denied = await staffOnly();
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const po = String(body.po ?? '').trim();
  const so = String(body.so ?? '').trim();
  if (!SIX_DIGITS.test(po) || !SIX_DIGITS.test(so)) {
    return NextResponse.json({ error: 'PO and SO must both be 6-digit Arrow order numbers' }, { status: 400 });
  }

  const links = await loadContainerLinks();
  links[po] = so;
  await redis.set(CONTAINER_LINKS_KEY, JSON.stringify(links));
  return NextResponse.json({ ok: true, links });
}

export async function DELETE(req: NextRequest) {
  const denied = await staffOnly();
  if (denied) return denied;

  const po = String(req.nextUrl.searchParams.get('po') ?? '').trim();
  if (!SIX_DIGITS.test(po)) {
    return NextResponse.json({ error: 'PO must be a 6-digit Arrow order number' }, { status: 400 });
  }

  const links = await loadContainerLinks();
  delete links[po];
  await redis.set(CONTAINER_LINKS_KEY, JSON.stringify(links));
  return NextResponse.json({ ok: true, links });
}
