import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { redis, getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, PricingRule } from '@/lib/pricing';

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
  customerCode: string;
}

interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  listPrice?: number | null;
  supplierStock?: string | null;
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }>;
}

interface CustomerProfile {
  name: string;
  priceType: string | null;
}

export interface FulfillableLine {
  sku: string;
  productName: string | null;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  onHandTotal: number;
  fulfillableQty: number;
  unitPrice: number | null;
  lineBackorderValue: number | null;   // revenue being held up (price × backorder qty)
  lineFulfillableValue: number | null; // revenue we can unlock now (price × fulfillable qty)
  canFullyFulfil: boolean;
}

export interface FulfillableOrder {
  orderNo: string;
  customerOrderNo: string | null;
  customerCode: string;
  customerName: string;
  orderDate: string;
  expectedDate: string;
  statusFlag: string;
  lines: FulfillableLine[];
  fullyFulfillable: boolean;    // every backordered line can ship
  partiallyFulfillable: boolean; // at least one line can ship
  orderBackorderValue: number;   // total $ being held up
  orderFulfillableValue: number; // total $ that can ship now
}

export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }
  if (!access.isAggregate) {
    return NextResponse.json(
      { error: 'Warehouse fulfillment is only available to internal staff' },
      { status: 403 }
    );
  }

  // Load all the data we need in parallel
  const [rawLines, allStock, customerNames, customerProfiles] = await Promise.all([
    getJSON<OrderLine[]>(`orders:group:${access.groupKey}`),
    getJSON<StockEntry[]>('stock:all'),
    getJSON<Record<string, string>>('customerNames'),
    getJSON<Record<string, CustomerProfile>>('customerProfiles'),
  ]);

  // Build a stock index and on-hand total by SKU
  const stockBySkuMap = new Map<string, StockEntry>();
  const onHandBySku = new Map<string, number>();
  for (const entry of allStock ?? []) {
    stockBySkuMap.set(entry.sku, entry);
    const total = Object.values(entry.byLocation ?? {}).reduce(
      (sum, l) => sum + (l.onHand || 0),
      0
    );
    onHandBySku.set(entry.sku, total);
  }

  // Only look at open orders with backordered lines
  const openLines = (rawLines ?? []).filter(
    (l) =>
      (l.statusFlag === 'B' || l.statusFlag === 'A' || l.statusFlag === 'H') &&
      l.qtyBackordered > 0
  );

  if (openLines.length === 0) {
    return NextResponse.json({
      orders: [],
      summary: {
        totalOrders: 0,
        fullyFulfillable: 0,
        partiallyFulfillable: 0,
        totalBackorderValue: 0,
        totalFulfillableValue: 0,
      },
    });
  }

  // Batch-fetch price types for every unique customer code
  const uniqueCodes = [...new Set(openLines.map((l) => l.customerCode))];
  const priceTypeValues = await Promise.all(
    uniqueCodes.map((code) => redis.get<string>(`customerPriceType:${code}`))
  );
  const priceTypeByCode = new Map<string, string>();
  uniqueCodes.forEach((code, i) => {
    const pt = priceTypeValues[i];
    if (pt) priceTypeByCode.set(code, pt.trim());
  });

  // Batch-fetch pricing rules for every unique price type
  const uniquePriceTypes = [...new Set(priceTypeByCode.values())];
  const pricingRulesValues = await Promise.all(
    uniquePriceTypes.map((pt) => getJSON<PricingRule[]>(`pricing:${pt}`))
  );
  const rulesByPriceType = new Map<string, PricingRule[]>();
  uniquePriceTypes.forEach((pt, i) => {
    rulesByPriceType.set(pt, pricingRulesValues[i] ?? []);
  });

  // Group lines by order number
  const orderMap = new Map<string, OrderLine[]>();
  for (const line of openLines) {
    if (!orderMap.has(line.orderNo)) orderMap.set(line.orderNo, []);
    orderMap.get(line.orderNo)!.push(line);
  }

  // Build the enriched fulfillable order list
  const fulfillableOrders: FulfillableOrder[] = [];

  for (const [orderNo, lines] of orderMap) {
    const sampleLine = lines[0];
    const customerCode = sampleLine.customerCode;
    const priceType = priceTypeByCode.get(customerCode);
    const rules = priceType ? (rulesByPriceType.get(priceType) ?? []) : [];

    const enrichedLines: FulfillableLine[] = lines.map((l) => {
      const stock = stockBySkuMap.get(l.sku);
      const onHandTotal = onHandBySku.get(l.sku) ?? 0;
      const fulfillableQty = Math.min(l.qtyBackordered, onHandTotal);
      const canFullyFulfil = onHandTotal >= l.qtyBackordered;

      const rule = findRuleForSku(rules, l.sku, stock?.stockCategory);
      const listPrice = stock?.listPrice ?? null;
      const unitPrice = rule ? computePrice(rule, l.qtyOrdered, listPrice) : null;

      const lineBackorderValue = unitPrice != null ? unitPrice * l.qtyBackordered : null;
      const lineFulfillableValue =
        unitPrice != null ? unitPrice * fulfillableQty : null;

      return {
        sku: l.sku,
        productName: stock?.name ?? null,
        qtyOrdered: l.qtyOrdered,
        qtyShipped: l.qtyShipped,
        qtyBackordered: l.qtyBackordered,
        onHandTotal,
        fulfillableQty,
        unitPrice,
        lineBackorderValue,
        lineFulfillableValue,
        canFullyFulfil,
      };
    });

    const partiallyFulfillable = enrichedLines.some((l) => l.fulfillableQty > 0);
    const fullyFulfillable = enrichedLines.every((l) => l.canFullyFulfil);
    const orderBackorderValue = enrichedLines.reduce(
      (sum, l) => sum + (l.lineBackorderValue ?? 0),
      0
    );
    const orderFulfillableValue = enrichedLines.reduce(
      (sum, l) => sum + (l.lineFulfillableValue ?? 0),
      0
    );

    if (!partiallyFulfillable) continue; // skip orders where nothing can ship yet

    fulfillableOrders.push({
      orderNo,
      customerOrderNo: sampleLine.customerOrderNo,
      customerCode,
      customerName:
        customerNames?.[customerCode] ??
        customerProfiles?.[customerCode]?.name ??
        customerCode,
      orderDate: sampleLine.orderDate,
      expectedDate: sampleLine.expectedDate,
      statusFlag: sampleLine.statusFlag,
      lines: enrichedLines,
      fullyFulfillable,
      partiallyFulfillable,
      orderBackorderValue,
      orderFulfillableValue,
    });
  }

  // Sort: fully fulfillable first (highest priority), then by expected date
  fulfillableOrders.sort((a, b) => {
    if (a.fullyFulfillable !== b.fullyFulfillable)
      return a.fullyFulfillable ? -1 : 1;
    return new Date(a.expectedDate).getTime() - new Date(b.expectedDate).getTime();
  });

  const totalBackorderValue = fulfillableOrders.reduce(
    (sum, o) => sum + o.orderBackorderValue,
    0
  );
  const totalFulfillableValue = fulfillableOrders.reduce(
    (sum, o) => sum + o.orderFulfillableValue,
    0
  );

  return NextResponse.json({
    orders: fulfillableOrders,
    summary: {
      totalOrders: fulfillableOrders.length,
      fullyFulfillable: fulfillableOrders.filter((o) => o.fullyFulfillable).length,
      partiallyFulfillable: fulfillableOrders.filter(
        (o) => o.partiallyFulfillable && !o.fullyFulfillable
      ).length,
      totalBackorderValue,
      totalFulfillableValue,
    },
  });
}
