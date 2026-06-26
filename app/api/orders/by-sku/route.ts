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

export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const sku = searchParams.get('sku')?.trim();
  if (!sku) {
    return NextResponse.json({ error: 'Provide a sku query parameter' }, { status: 400 });
  }

  // One pre-aggregated read for head office / Hayward-everything, instead
  // of fanning out across every individual customer code.
  const [rawLines, customerNames] = await Promise.all([
    access.isHeadOffice
      ? getJSON<OrderLine[]>(`orders:group:${access.groupKey}`)
      : getJSON<OrderLine[]>(`orders:${access.branchCode}`),
    getJSON<Record<string, string>>('customerNames'),
  ]);

  const orders = (rawLines ?? [])
    .filter((line) => line.sku === sku)
    .map((line) => {
      const code = line.customerCode ?? access.branchCode ?? '';
      return {
        ...line,
        customerCode: code,
        branchName: customerNames?.[code] ?? null,
      };
    })
    .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());

  return NextResponse.json({ sku, orders });
}
