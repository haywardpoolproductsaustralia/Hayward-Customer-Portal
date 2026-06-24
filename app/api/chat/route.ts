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
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }>;
}

interface OrderLine {
  orderNo: string;
  orderDate: string;
  statusFlag: string;
  sku: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
}

const MAX_TOOL_ROUNDS = 5;

// --- Tool implementations - each one reuses the exact same logic the
// rest of the app already relies on, rather than re-deriving anything. ---

async function toolSearchProducts(query: string) {
  const all = (await getJSON<StockEntry[]>('stock:all')) ?? [];
  const trimmed = query.toUpperCase();
  const matches = all
    .filter((r) => r.sku.includes(trimmed) || (r.name ?? '').toUpperCase().includes(trimmed))
    .slice(0, 10)
    .map((r) => ({
      sku: r.sku,
      name: r.name,
      totalOnHand: Object.values(r.byLocation ?? {}).reduce((sum, l) => sum + (l.onHand || 0), 0),
    }));
  return { matches, truncated: matches.length === 10 };
}

async function toolGetPrice(access: CustomerAccess, sku: string, qty = 1) {
  const representativeCode = access.branchCode ?? access.customerCodes[0];
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

async function toolGetOrderHistory(access: CustomerAccess, sku?: string) {
  const perCustomer = await Promise.all(
    access.customerCodes.map(async (code) => {
      const lines = (await getJSON<OrderLine[]>(`orders:${code}`)) ?? [];
      return (sku ? lines.filter((l) => l.sku === sku) : lines).map((l) => ({ ...l, customerCode: code }));
    })
  );
  const orders = perCustomer.flat().slice(0, 20);
  return { orders, truncated: orders.length === 20 };
}

const tools: Anthropic.Tool[] = [
  {
    name: 'search_products',
    description: 'Search the product catalog by SKU or product name. Returns matching products with current stock levels.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'SKU or product name to search for' } },
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
    description: "Get this customer's past orders (last ~90 days), optionally filtered to one SKU.",
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'Optional - filter to orders containing this SKU' } },
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

  const systemPrompt = `You are a helpful assistant inside Hayward Pool Products' customer portal, currently helping someone from ${access.groupName}.

You have tools to check live stock, pricing, and order history - always use them for any question about a specific product's price, stock level, or this customer's orders. Never guess or estimate a price or stock level from general knowledge; if a tool returns an error or no result, say so plainly rather than making something up.

If manual content is attached to the conversation, use it to answer technical or installation questions, including describing diagrams or labelled photos if the manual is a PDF. If no relevant manual is attached and the question clearly needs one, say you don't have that manual rather than guessing at the answer.

Keep answers concise and practical - this is a trade/B2B audience, not a general consumer chatbot.`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: [...manualBlocks, { type: 'text', text: userMessage }] },
  ];

  let finalText = '';

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
          } else if (tu.name === 'get_price') {
            result = await toolGetPrice(access, String(input.sku ?? ''), Number(input.qty ?? 1));
          } else if (tu.name === 'get_order_history') {
            result = await toolGetOrderHistory(access, input.sku ? String(input.sku) : undefined);
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
  });
}
