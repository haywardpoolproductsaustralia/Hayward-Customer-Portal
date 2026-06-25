import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getCustomerAccess, CustomerAccess } from '@/lib/access';
import { redis, getJSON } from '@/lib/redis';
import { computePrice, findRuleForSku, PricingRule } from '@/lib/pricing';
import { findRelevantManuals } from '@/lib/manuals';

interface StockEntry {
  sku: string;
  name?: string | null;
  stockCategory?: string | null;
  listPrice?: number | null;
  supplierStock?: string | null;
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }>;
}

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

const MAX_TOOL_ROUNDS = 5;

// --- Tool implementations - each one reuses the exact same logic the
// rest of the app already relies on, rather than re-deriving anything. ---

async function toolSearchProducts(query: string) {
  const all = (await getJSON<StockEntry[]>('stock:all')) ?? [];

  // Multi-word matching (every word must appear somewhere in SKU or name)
  // rather than one literal phrase - "sand filter" should match "FILTER
  // SAND TYPE X" just as well as "SAND FILTER SYSTEM", regardless of
  // word order. This also makes partial SKU codes work naturally - a
  // single "word" query like "AV250" still matches via substring.
  const words = query.toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { matches: [], truncated: false };

  const filtered = all.filter((r) => {
    const haystack = `${r.sku} ${r.name ?? ''} ${r.supplierStock ?? ''}`.toUpperCase();
    return words.every((w) => haystack.includes(w));
  });

  const matches = filtered.slice(0, 12).map((r) => ({
    sku: r.sku,
    name: r.name,
    totalOnHand: Object.values(r.byLocation ?? {}).reduce((sum, l) => sum + (l.onHand || 0), 0),
  }));

  return { matches, truncated: filtered.length > 12 };
}

async function toolGetPrice(access: CustomerAccess, sku: string, qty = 1, overrideCode?: string) {
  const representativeCode =
    overrideCode && access.customerCodes.includes(overrideCode)
      ? overrideCode
      : access.branchCode ?? access.customerCodes[0];
  if (!representativeCode) return { error: 'No customer code resolved for this account.' };

  const priceType = await redis.get<string>(`customerPriceType:${representativeCode}`);
  if (!priceType) return { error: 'No price type found for this customer.' };

  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];
  const stockEntry = await getJSON<StockEntry>(`stock:${sku}`);
  if (!stockEntry) return { error: `SKU "${sku}" not found.` };

  const rule = findRuleForSku(rules, sku, stockEntry.stockCategory);
  if (!rule) return { error: `No pricing rule found yet for "${sku}".` };

  const listPrice = stockEntry.listPrice ?? null;
  const price = computePrice(rule, qty, listPrice);
  return { sku, qty, listPrice, price, name: stockEntry.name };
}

async function toolGetOrderHistory(access: CustomerAccess, sku?: string, orderNo?: string) {
  const [rawLines, customerNames] = await Promise.all([
    access.isHeadOffice
      ? getJSON<OrderLine[]>(`orders:group:${access.groupKey}`)
      : getJSON<OrderLine[]>(`orders:${access.branchCode}`),
    getJSON<Record<string, string>>('customerNames'),
  ]);

  const withCode = (rawLines ?? []).map((l) => ({
    ...l,
    customerCode: l.customerCode ?? access.branchCode ?? '',
  }));

  let orders = withCode.map((o) => ({ ...o, branchName: customerNames?.[o.customerCode] ?? null }));

  // An exact order-number search (Hayward's own number OR the customer's
  // own PO/reference number) takes priority and is never capped or
  // filtered by SKU - finding the one order someone's asking about
  // matters more than staying under a result limit.
  if (orderNo) {
    const trimmed = orderNo.trim();
    orders = orders.filter((o) => o.orderNo === trimmed || o.customerOrderNo === trimmed);
    return { orders, truncated: false };
  }

  if (sku) {
    orders = orders.filter((o) => o.sku === sku);
  }

  orders = orders.sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
  const truncated = orders.length > 20;
  return { orders: orders.slice(0, 20), truncated };
}

const tools: Anthropic.Tool[] = [
  {
    name: 'search_products',
    description:
      'Search the product catalog by product description, type, partial SKU, full SKU, or supplier\'s own part number. Words can appear in any order and don\'t need to be a full SKU - "sand filter", "av250", and "1A-AV250LI" are all valid, and so is a supplier part number if that\'s what someone gives you. Use this any time someone describes what they\'re after rather than giving an exact SKU - e.g. "what sand filters do you have" should search "sand filter", not be treated as a question you answer from general knowledge. Returns matching products with current stock levels.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Product description, partial SKU, or full SKU' } },
      required: ['query'],
    },
  },
  {
    name: 'get_price',
    description: "Get this customer's actual discounted price for a specific SKU at a given quantity. Always use this for any pricing question - never estimate or guess a price.",
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        qty: { type: 'number', description: 'Quantity to price. Defaults to 1 if not specified.' },
      },
      required: ['sku'],
    },
  },
  {
    name: 'get_order_history',
    description:
      "Get this customer's past orders (last ~90 days). Can search by SKU, or look up one specific order by its order number - this accepts EITHER Hayward's own order number OR the customer's own order/PO reference number (both are searched), so always use this when someone gives you any order number, regardless of which kind it is.",
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Optional - filter to orders containing this SKU' },
        orderNo: {
          type: 'string',
          description: "Optional - find one specific order by number. Matches either Hayward's order number or the customer's own order/PO number.",
        },
      },
    },
  },
];

export async function POST(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'Chat is not configured (missing ANTHROPIC_API_KEY).' }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const userMessage = body?.message?.trim();
  const customerCodeOverride = typeof body?.customerCode === 'string' ? body.customerCode.trim() : undefined;
  const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(body?.history)
    ? body.history
    : [];

  if (!userMessage) {
    return NextResponse.json({ error: 'Provide a message' }, { status: 400 });
  }

  // Pull in relevant manual content up front, rather than as a tool -
  // this is reference material, not something worth a round trip for.
  // A timeout guard matters here: a broken or unreachable manual URL
  // should never be able to hang the whole chat request.
  const relevantManuals = findRelevantManuals(userMessage, 2);
  const manualBlocks: Anthropic.ContentBlockParam[] = [];
  for (const m of relevantManuals) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        if (m.url.endsWith('.md')) {
          const res = await fetch(m.url, { signal: controller.signal });
          const text = await res.text();
          manualBlocks.push({ type: 'text', text: `--- Manual: ${m.title} ---\n${text}` });
        } else if (m.url.toLowerCase().endsWith('.pdf')) {
          const res = await fetch(m.url, { signal: controller.signal });
          const buf = await res.arrayBuffer();
          manualBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buf).toString('base64') },
            title: m.title,
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // A manual failing to fetch (or timing out) shouldn't fail the whole chat turn.
    }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const customerContextNote =
    customerCodeOverride && access.customerCodes.includes(customerCodeOverride)
      ? `\n\nThe person has selected a specific customer to view pricing as (via the picker in the top bar) - any price you give will be that customer's actual rate, not a generic one. Mention which customer you're quoting for if it's not obvious from context.`
      : '';

  const systemPrompt = `You're a friendly, helpful assistant inside Hayward Pool Products' customer portal, currently helping someone from ${access.groupName}. Talk like a knowledgeable trade colleague, not a formal support bot - warm and direct, no corporate filler.${customerContextNote}

You have tools to check live stock, pricing, and order history - always use them for any question about a specific product's price, stock level, or this customer's orders. Never guess or estimate a price or stock level from general knowledge; if a tool returns an error or no result, say so plainly rather than making something up.

People will often describe what they want rather than give an exact SKU - "what sand filters do you have", "got any robotic cleaners in stock", a partial code like "av250" - search_products handles all of these naturally, so just search with whatever they said rather than asking them to look up the exact code first. If a search returns several matches, briefly list them (name + stock status is usually enough) rather than dumping every field for every result - the UI shows clickable cards for full details, so you don't need to explain pricing or order history for every single item unless asked.

If manual content is attached to the conversation, use it to answer technical or installation questions, including describing diagrams or labelled photos if the manual is a PDF. If no relevant manual is attached and the question clearly needs one, say you don't have that manual rather than guessing at the answer.

Keep answers concise and practical - this is a trade/B2B audience, not a general consumer chatbot.`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: [...manualBlocks, { type: 'text', text: userMessage }] },
  ];

  let finalText = '';
  const surfacedProducts = new Map<string, { sku: string; name: string | null | undefined; totalOnHand: number }>();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
    });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    finalText = textBlocks.map((b) => b.text).join('\n');

    if (toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        let result: unknown;
        try {
          const input = tu.input as Record<string, unknown>;
          if (tu.name === 'search_products') {
            result = await toolSearchProducts(String(input.query ?? ''));
            for (const m of (result as { matches: { sku: string; name: string | null | undefined; totalOnHand: number }[] }).matches) {
              surfacedProducts.set(m.sku, m);
            }
          } else if (tu.name === 'get_price') {
            result = await toolGetPrice(access, String(input.sku ?? ''), Number(input.qty ?? 1), customerCodeOverride);
          } else if (tu.name === 'get_order_history') {
            result = await toolGetOrderHistory(
              access,
              input.sku ? String(input.sku) : undefined,
              input.orderNo ? String(input.orderNo) : undefined
            );
          } else {
            result = { error: 'Unknown tool' };
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : 'Tool failed' };
        }
        return {
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        };
      })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  return NextResponse.json({
    reply: finalText || "I couldn't generate a response - try rephrasing your question.",
    manualsUsed: relevantManuals.map((m) => m.title),
    products: [...surfacedProducts.values()].slice(0, 12),
  });
}
