import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

interface OrderLine {
  orderNo: string;
  orderDate: string;
  expectedDate: string;
  statusFlag: string;
  sku: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
}

// Best-guess labels from analysing real STATUS_FLAG distribution against
// known order ages - see portal-sync/README.md for how these were derived.
// Worth correcting here if any turn out to be wrong once customers are using it.
const STATUS_LABELS: Record<string, string> = {
  C: 'Completed',
  A: 'Active',
  X: 'Cancelled',
  '': 'Draft',
  S: 'Standing order',
  H: 'On hold',
  B: 'Backordered',
};

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const perCustomer = await Promise.all(
    access.customerCodes.map(async (code) => {
      const lines = (await getJSON<OrderLine[]>(`orders:${code}`)) ?? [];
      return lines.map((line) => ({
        ...line,
        customerCode: code,
        statusLabel: STATUS_LABELS[line.statusFlag] ?? line.statusFlag,
      }));
    })
  );

  const orders = perCustomer.flat();
  return NextResponse.json({ orders, customerCodeCount: access.customerCodes.length });
}
