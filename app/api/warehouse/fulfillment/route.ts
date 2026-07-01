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
  orderDescn1: string | null;
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
  lineBackorderValue: number | null;
  lineFulfillableValue: number | null;
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
  orderDescn1: string | null;
  isContainer: boolean;
  lines: FulfillableLine[];
  fullyFulfillable: boolean;
  partiallyFulfillable: boolean;
  orderBackorderValue: number;
  orderFulfillableValue: number;
}

// Container detection: CONTAINER or FCL in ORDER_DESCN1.
// Bare MAINFREIGHT excluded until confirmed as always-container.
function detectContainer(descn: string | null): boolean {
  if (!descn) return false;
  const u = descn.toUpperCase();
  return u.includes('CONTAINER') || u.includes(' FCL') || u.startsWith('FCL');
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

  const [rawLines, allStock, customerNames, customerProfiles] = await Promise.all([
    getJSON<OrderLine[]>(`orders:group:${access.groupKey}`),
    getJSON<StockEntry[]>('stock:all'),
    getJSON<Record<string, string>>('customerNames'),
    getJSON<Record<string, CustomerProfile>>('customerProfiles'),
  ]);

  const stockBySkuMap = new Map<string, StockEntry>();
  const onHandBySku = new Map<string, number>();
  for (const entry of allStock ?? []) {
    stockBySkuMap.set(entry.sku, entry);
    const total = Object.values(entry.byLocation ?? {}).reduce(
      (sum, l) => sum + (l.onHand || 0), 0
    );
    onHandBySku.set(entry.sku, total);
  }

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
        containerOrders: 0,
        totalBackorderValue: 0,
        totalFulfillableValue: 0,
      },
    });
  }

  const uniqueCodes = [...new Set(openLines.map((l) => l.customerCode))];
  const priceTypeValues = await Promise.all(
    uniqueCodes.map((code) => redis.get<string>(`customerPriceType:${code}`))
  );
  const priceTypeByCode = new Map<string, string>();
  uniqueCodes.forEach((code, i) => {
    const pt = priceTypeValues[i];
    if (pt) priceTypeByCode.set(code, pt.trim());
  });

  const uniquePriceTypes = [...new Set(priceTypeByCode.values())];
  const pricingRulesValues = await Promise.all(
    uniquePriceTypes.map((pt) => getJSON<PricingRule[]>(`pricing:${pt}`))
  );
  const rulesByPriceType = new Map<string, PricingRule[]>();
  uniquePriceTypes.forEach((pt, i) => {
    rulesByPriceType.set(pt, pricingRulesValues[i] ?? []);
  });

  const orderMap = new Map<string, OrderLine[]>();
  for (const line of openLines) {
    if (!orderMap.has(line.orderNo)) orderMap.set(line.orderNo, []);
    orderMap.get(line.orderNo)!.push(line);
  }

  const fulfillableOrders: FulfillableOrder[] = [];

  for (const [orderNo, lines] of orderMap) {
    const sampleLine = lines[0];
    const customerCode = sampleLine.customerCode;
    const priceType = priceTypeByCode.get(customerCode);
    const rules = priceType ? (rulesByPriceType.get(priceType) ?? []) : [];
    const orderDescn1 = sampleLine.orderDescn1 ?? null;
    const isContainer = detectContainer(orderDescn1);

    const enrichedLines: FulfillableLine[] = lines.map((l) => {
      const stock = stockBySkuMap.get(l.sku);
      // Arrow allows negative on-hand when stock is overcommitted.
      // Clamp to 0 so we never produce negative fulfillable quantities
      // or negative dollar values on the warehouse page.
      const rawOnHand = onHandBySku.get(l.sku) ?? 0;
      const onHandTotal = Math.max(0, rawOnHand);
      const fulfillableQty = Math.max(0, Math.min(l.qtyBackordered, onHandTotal));
      const canFullyFulfil = onHandTotal >= l.qtyBackordered;
      const rule = findRuleForSku(rules, l.sku, stock?.stockCategory);
      const listPrice = stock?.listPrice ?? null;
      const unitPrice = rule ? computePrice(rule, l.qtyOrdered, listPrice) : null;
      const lineBackorderValue = unitPrice != null ? unitPrice * l.qtyBackordered : null;
      const lineFulfillableValue = unitPrice != null ? unitPrice * fulfillableQty : null;

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
    if (!partiallyFulfillable) continue;

    const fullyFulfillable = enrichedLines.every((l) => l.canFullyFulfil);
    const orderBackorderValue = enrichedLines.reduce(
      (sum, l) => sum + (l.lineBackorderValue ?? 0), 0
    );
    const orderFulfillableValue = enrichedLines.reduce(
      (sum, l) => sum + (l.lineFulfillableValue ?? 0), 0
    );

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
      orderDescn1,
      isContainer,
      lines: enrichedLines,
      fullyFulfillable,
      partiallyFulfillable,
      orderBackorderValue,
      orderFulfillableValue,
    });
  }

  const totalBackorderValue = fulfillableOrders.reduce(
    (sum, o) => sum + o.orderBackorderValue, 0
  );
  const totalFulfillableValue = fulfillableOrders.reduce(
    (sum, o) => sum + o.orderFulfillableValue, 0
  );

  return NextResponse.json({
    orders: fulfillableOrders,
    summary: {
      totalOrders: fulfillableOrders.length,
      fullyFulfillable: fulfillableOrders.filter((o) => o.fullyFulfillable).length,
      partiallyFulfillable: fulfillableOrders.filter(
        (o) => o.partiallyFulfillable && !o.fullyFulfillable
      ).length,
      containerOrders: fulfillableOrders.filter((o) => o.isContainer).length,
      totalBackorderValue,
      totalFulfillableValue,
    },
  });
}
