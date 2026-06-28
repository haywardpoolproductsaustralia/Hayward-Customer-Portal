import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

interface OrderLine {
  orderNo: string;
  customerOrderNo: string | null;
  orderDate: string;
  expectedDate: string;
  invoiceDate: string | null;
  statusFlag: string;
  sku: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  customerCode?: string;
}

const STATUS_LABELS: Record<string, string> = {
  C: 'Completed',
  A: 'Active',
  X: 'Cancelled',
  '': 'Draft',
  S: 'Standing order',
  H: 'On hold',
  B: 'Backordered',
};

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  // Optional: filter to a specific customer group selected from the
  // header picker. The picker passes one representative branch code
  // for the group - we look up that group name in codeToGroup, then
  // filter order lines to only codes belonging to that same group.
  // Security: the representative code must be in access.customerCodes,
  // so a Hayward login can't filter to a code outside their access.
  const requestedCode = req.nextUrl.searchParams.get('customerCode')?.trim();

  const [rawLines, customerNames, codeToGroup] = await Promise.all([
    access.isHeadOffice
      ? getJSON<OrderLine[]>(`orders:group:${access.groupKey}`)
      : getJSON<OrderLine[]>(`orders:${access.branchCode}`),
    getJSON<Record<string, string>>('customerNames'),
    getJSON<Record<string, string>>('codeToGroup'),
  ]);

  let lines = (rawLines ?? []).map((line) => ({
    ...line,
    customerCode: line.customerCode ?? access.branchCode ?? '',
  }));

  // Drop non-product lines. Comment / narrative lines in Arrow's SORTRAN carry a
  // blank stock code, and the field we read as a quantity holds a non-quantity
  // value for them - which is why they surfaced as nonsensical "ordered" numbers
  // (e.g. 348,000). Customers only need real product lines.
  lines = lines.filter((l) => (l.sku ?? '').trim() !== '');

  // If a representative code was requested and it's in the allowed set,
  // resolve its group name and filter to all codes in that group.
  if (requestedCode && access.customerCodes.includes(requestedCode) && codeToGroup) {
    const targetGroup = codeToGroup[requestedCode];
    if (targetGroup) {
      lines = lines.filter((l) => codeToGroup[l.customerCode] === targetGroup);
    }
  }

  const orders = lines.map((o) => ({
    ...o,
    statusLabel: STATUS_LABELS[o.statusFlag] ?? o.statusFlag,
    branchName: customerNames?.[o.customerCode] ?? o.customerCode,
  }));

  return NextResponse.json({
    orders,
    isHeadOffice: access.isHeadOffice,
    customerCodeCount: access.customerCodes.length,
  });
}
