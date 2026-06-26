import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

interface OrderLine {
  orderNo: string;
  customerOrderNo: string | null;
  orderDate: string;
  expectedDate: string;
  orderDescn1: string | null;
  statusFlag: string;
  sku: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  customerCode: string;
}

export interface DuplicateMatch {
  orderNo: string;
  orderDate: string;     // the other order it matches
  customerOrderNo: string | null;
  statusFlag: string;
}

export interface DuplicateLine {
  sku: string;
  productName: string | null;
  qtyOrdered: number;
  matchedOrders: DuplicateMatch[];
}

export interface DuplicateOrder {
  orderNo: string;
  customerOrderNo: string | null;
  customerCode: string;
  customerName: string;
  orderDate: string;
  orderDescn1: string | null;
  statusFlag: string;
  duplicateLines: DuplicateLine[];
}

const STATUS_LABELS: Record<string, string> = {
  C: 'Completed', A: 'Active', X: 'Cancelled',
  B: 'Backordered', H: 'On hold', S: 'Standing', '': 'Draft',
};

// Normalise a datetime to its AEST date string (YYYY-MM-DD) so we
// compare calendar days rather than exact timestamps - two orders
// placed on the same day in Sydney should match regardless of the
// exact time they were submitted.
function toAESTDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Australia/Sydney' }); // sv-SE gives YYYY-MM-DD
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }
  if (!access.isAggregate) {
    return NextResponse.json(
      { error: 'Duplicate detection is only available to internal staff' },
      { status: 403 }
    );
  }

  const [rawLines, customerNames, allStock] = await Promise.all([
    getJSON<OrderLine[]>(`orders:group:${access.groupKey}`),
    getJSON<Record<string, string>>('customerNames'),
    getJSON<{ sku: string; name?: string | null }[]>('stock:all'),
  ]);

  const productNames = new Map<string, string>();
  for (const s of allStock ?? []) {
    if (s.name) productNames.set(s.sku, s.name);
  }

  const lines = rawLines ?? [];

  // Build a map: (customerCode + sku + qtyOrdered) → list of
  // { orderNo, orderDate (AEST), customerOrderNo, statusFlag }
  // This lets us find every order that shares the same customer/sku/qty.
  type GroupKey = string;
  const groups = new Map<GroupKey, {
    orderNo: string;
    orderDate: string;
    aestDate: string;
    customerOrderNo: string | null;
    statusFlag: string;
    customerCode: string;
    orderDescn1: string | null;
  }[]>();

  for (const line of lines) {
    // Cancelled orders intentionally excluded - they've been dealt with
    if (line.statusFlag === 'X') continue;

    const key: GroupKey = `${line.customerCode}||${line.sku}||${line.qtyOrdered}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      orderNo: line.orderNo,
      orderDate: line.orderDate,
      aestDate: toAESTDate(line.orderDate),
      customerOrderNo: line.customerOrderNo,
      statusFlag: line.statusFlag,
      customerCode: line.customerCode,
      orderDescn1: line.orderDescn1,
    });
  }

  // For each group, find pairs that share the same AEST date.
  // These are the confirmed duplicates.
  const flaggedOrderNos = new Set<string>();
  const duplicateLinesByOrder = new Map<string, DuplicateLine[]>();

  for (const [key, entries] of groups) {
    if (entries.length < 2) continue;

    // Group entries by aestDate within this (customer+sku+qty) bucket
    const byDate = new Map<string, typeof entries>();
    for (const e of entries) {
      if (!byDate.has(e.aestDate)) byDate.set(e.aestDate, []);
      byDate.get(e.aestDate)!.push(e);
    }

    for (const [, dateEntries] of byDate) {
      if (dateEntries.length < 2) continue;

      // Every order in this date bucket is a potential duplicate
      const [, sku, qtyStr] = key.split('||');
      const qtyOrdered = Number(qtyStr);

      for (const entry of dateEntries) {
        flaggedOrderNos.add(entry.orderNo);

        if (!duplicateLinesByOrder.has(entry.orderNo)) {
          duplicateLinesByOrder.set(entry.orderNo, []);
        }

        const existingLine = duplicateLinesByOrder
          .get(entry.orderNo)!
          .find((l) => l.sku === sku);

        const matchedOrders: DuplicateMatch[] = dateEntries
          .filter((e) => e.orderNo !== entry.orderNo)
          .map((e) => ({
            orderNo: e.orderNo,
            orderDate: e.orderDate,
            customerOrderNo: e.customerOrderNo,
            statusFlag: STATUS_LABELS[e.statusFlag] ?? e.statusFlag,
          }));

        if (!existingLine) {
          duplicateLinesByOrder.get(entry.orderNo)!.push({
            sku,
            productName: productNames.get(sku) ?? null,
            qtyOrdered,
            matchedOrders,
          });
        }
      }
    }
  }

  if (flaggedOrderNos.size === 0) {
    return NextResponse.json({ duplicateOrders: [], totalFlagged: 0 });
  }

  // Build the full duplicate order objects
  // One entry per unique orderNo - take first matching line for metadata
  const orderMeta = new Map<string, {
    customerOrderNo: string | null;
    customerCode: string;
    orderDate: string;
    orderDescn1: string | null;
    statusFlag: string;
  }>();

  for (const line of lines) {
    if (!flaggedOrderNos.has(line.orderNo)) continue;
    if (orderMeta.has(line.orderNo)) continue;
    orderMeta.set(line.orderNo, {
      customerOrderNo: line.customerOrderNo,
      customerCode: line.customerCode,
      orderDate: line.orderDate,
      orderDescn1: line.orderDescn1,
      statusFlag: line.statusFlag,
    });
  }

  const duplicateOrders: DuplicateOrder[] = [];
  for (const [orderNo, meta] of orderMeta) {
    duplicateOrders.push({
      orderNo,
      customerOrderNo: meta.customerOrderNo,
      customerCode: meta.customerCode,
      customerName: customerNames?.[meta.customerCode] ?? meta.customerCode,
      orderDate: meta.orderDate,
      orderDescn1: meta.orderDescn1,
      statusFlag: STATUS_LABELS[meta.statusFlag] ?? meta.statusFlag,
      duplicateLines: duplicateLinesByOrder.get(orderNo) ?? [],
    });
  }

  // Sort: most recent orders first
  duplicateOrders.sort(
    (a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime()
  );

  return NextResponse.json({
    duplicateOrders,
    totalFlagged: duplicateOrders.length,
  });
}
