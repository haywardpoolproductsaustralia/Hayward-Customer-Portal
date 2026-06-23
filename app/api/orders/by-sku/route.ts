import { NextRequest, NextResponse } from 'next/server';
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

  const perCustomer = await Promise.all(
    access.customerCodes.map(async (code) => {
      const lines = (await getJSON<OrderLine[]>(`orders:${code}`)) ?? [];
      return lines
        .filter((line) => line.sku === sku)
        .map((line) => ({ ...line, customerCode: code }));
    })
  );

  const orders = perCustomer
    .flat()
    .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());

  return NextResponse.json({ sku, orders });
}
