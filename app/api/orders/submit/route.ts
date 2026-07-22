import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getCustomerAccess, resolvePriceType } from "@/lib/access";
import { getJSON } from "@/lib/redis";
import { computePrice, findRuleForSku, PricingRule } from "@/lib/pricing";
import { PORTAL_ORDERS_ENABLED } from "@/lib/features";
import {
  createPortalOrder,
  findDuplicate,
  getPortalOrder,
  nextRef,
  PortalOrderLine,
} from "@/lib/portal-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/orders/submit
 *
 * Called by the quote builder's "Convert to order" panel. This is the ONLY way
 * a customer order enters the portal-orders queue.
 *
 * Two rules drive everything in here:
 *
 *  1. The browser is not trusted for money or for identity. Prices are
 *     recomputed from the pricing rules server-side; the quoted price the
 *     client sent is kept only so an agent can see any disagreement. The
 *     debtor code must be one the caller's Clerk org actually grants.
 *
 *  2. A rejected order is better than a wrong one. Anything that doesn't
 *     validate returns 400 with a specific message rather than being silently
 *     coerced — a bad order that looks fine is exactly the failure mode the
 *     emailed-order queue already suffers from.
 */

const MAX_LINES = 200;
const MAX_QTY = 99_999;

/**
 * These are Arrow's own column widths (CLEVAQUIP schema), not arbitrary caps.
 * Anything longer than these cannot survive being keyed into SORMAST/SORTRAN,
 * and a truncated customer PO is worse than a rejected one: it silently breaks
 * both the debtor+PO duplicate key here and portal-sync's Arrow match later.
 */
const ARROW = {
  poRef: 15,        // SORMAST.CUSTOMER_ORDER  char(15)
  sku: 15,          // SORTRAN.STOCK_CODE      char(15)
  deliverTo: 120,   // SORMAST.DELIVERY_NOTE_1..4  4 x char(30)
  contact: 30,      // SORMAST.CONTACT_NAME    char(30)
  phone: 30,        // SORMAST.PHONE_FAX       char(30)
  notes: 150,       // SORMAST.ORDER_DESCN1..3 3 x char(50)
} as const;

interface SubmitLine {
  sku?: unknown;
  qty?: unknown;
  unitPrice?: unknown; // what the customer was shown
}

interface StockRecord {
  name?: string | null;
  stockCategory?: string | null;
  listPrice?: number | null;
  byLocation?: Record<string, { onHand: number; allocated: number; backordered: number }>;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
};

function freeStock(entry: StockRecord | null): number | null {
  if (!entry?.byLocation) return null;
  return Object.values(entry.byLocation).reduce(
    (sum, l) => sum + ((l?.onHand ?? 0) - (l?.allocated ?? 0)),
    0
  );
}

export async function POST(req: NextRequest) {
  // Ordering is switched off. Refuse rather than accept an order into a queue
  // that is currently hidden from staff — a silently stored order is worse
  // than a clear rejection.
  if (!PORTAL_ORDERS_ENABLED) {
    return NextResponse.json(
      { error: "Online ordering is temporarily unavailable. Please send your order to au-orders@hayward.com." },
      { status: 503 }
    );
  }

  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Malformed request" }, { status: 400 });

  // --- header validation ---------------------------------------------------

  const debtorCode = str(body.debtorCode, 6);
  if (!debtorCode) {
    return NextResponse.json({ error: "Select the account this order is for." }, { status: 400 });
  }
  // The single most important check in this file: a login can only ever raise
  // an order against an account its own organization holds.
  if (!access.customerCodes.includes(debtorCode)) {
    return NextResponse.json(
      { error: "That account isn't available on your login." },
      { status: 403 }
    );
  }

  const poRefRaw = str(body.poRef, 200);
  if (!poRefRaw) {
    return NextResponse.json({ error: "Your purchase order number is required." }, { status: 400 });
  }
  // Truncating here would be the worst option available: the shortened value
  // would no longer match either the duplicate key or the PO that eventually
  // reaches Arrow, so the order would look new forever. Reject instead.
  if (poRefRaw.length > ARROW.poRef) {
    return NextResponse.json(
      { error: `Purchase order numbers can be at most ${ARROW.poRef} characters.` },
      { status: 400 }
    );
  }
  const poRef = poRefRaw;

  const requiredBy = str(body.requiredBy, 10); // YYYY-MM-DD from a date input
  if (requiredBy && !/^\d{4}-\d{2}-\d{2}$/.test(requiredBy)) {
    return NextResponse.json({ error: "Required-by date is not a valid date." }, { status: 400 });
  }

  const deliverTo = str(body.deliverTo, ARROW.deliverTo);
  const contact = str(body.contact, ARROW.contact);
  const phone = str(body.phone, ARROW.phone);
  const notes = str(body.notes, ARROW.notes);

  // --- line validation -----------------------------------------------------

  const rawLines: SubmitLine[] = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    return NextResponse.json({ error: "The order has no lines." }, { status: 400 });
  }
  if (rawLines.length > MAX_LINES) {
    return NextResponse.json(
      { error: `Orders are limited to ${MAX_LINES} lines. Please split this one.` },
      { status: 400 }
    );
  }

  const seen = new Set<string>();
  const cleaned: { sku: string; qty: number; quoted: number | null }[] = [];
  for (const l of rawLines) {
    const sku = str(l.sku, 200)?.toUpperCase();
    if (!sku) return NextResponse.json({ error: "A line is missing its product." }, { status: 400 });
    if (sku.length > ARROW.sku) {
      return NextResponse.json({ error: `Unrecognised product code: ${sku}` }, { status: 400 });
    }
    if (seen.has(sku)) {
      return NextResponse.json(
        { error: `${sku} appears more than once — combine it into a single line.` },
        { status: 400 }
      );
    }
    seen.add(sku);

    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return NextResponse.json(
        { error: `Quantity for ${sku} must be a whole number of at least 1.` },
        { status: 400 }
      );
    }
    const quotedRaw = Number(l.unitPrice);
    cleaned.push({ sku, qty, quoted: Number.isFinite(quotedRaw) ? quotedRaw : null });
  }

  // --- duplicate guard -----------------------------------------------------
  // Same account + same customer PO almost always means a double-click or a
  // re-send, which is exactly how duplicate orders get keyed into Arrow today.
  const existingId = await findDuplicate(debtorCode, poRef);
  if (existingId && body.confirmDuplicate !== true) {
    const existing = await getPortalOrder(existingId);
    return NextResponse.json(
      {
        error: "duplicate",
        message: `PO ${poRef} has already been submitted for this account${
          existing ? ` as ${existing.ref}` : ""
        }.`,
        existingRef: existing?.ref ?? null,
        existingSubmittedAt: existing?.submittedAt ?? null,
      },
      { status: 409 }
    );
  }

  // --- server-side repricing ----------------------------------------------

  const { representativeCode, priceType } = await resolvePriceType(access, debtorCode);
  if (!representativeCode || !priceType) {
    return NextResponse.json(
      { error: "We couldn't resolve pricing for this account. Please contact Hayward." },
      { status: 409 }
    );
  }

  const rules = (await getJSON<PricingRule[]>(`pricing:${priceType}`)) ?? [];
  const stockEntries = await Promise.all(
    cleaned.map((l) => getJSON<StockRecord>(`stock:${l.sku}`))
  );

  const missing = cleaned.filter((l, i) => !stockEntries[i]).map((l) => l.sku);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `These products are no longer available: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  const lines: PortalOrderLine[] = cleaned.map((l, i) => {
    const entry = stockEntries[i]!;
    const listPrice = entry.listPrice ?? null;
    const rule = findRuleForSku(rules, l.sku, entry.stockCategory ?? null);
    // Price at the LINE's own quantity, so quantity breaks apply per line
    // exactly as the quote builder displayed them.
    const unitPriceServer = rule ? computePrice(rule, l.qty, listPrice) : null;

    const mismatch =
      l.quoted != null && unitPriceServer != null && Math.abs(l.quoted - unitPriceServer) > 0.005;

    return {
      sku: l.sku,
      description: entry.name ?? null,
      qty: l.qty,
      listPrice,
      unitPriceQuoted: l.quoted,
      unitPriceServer,
      priceMismatch: mismatch,
      lineTotal: unitPriceServer != null ? Math.round(unitPriceServer * l.qty * 100) / 100 : null,
      onHandAtSubmit: freeStock(entry),
    };
  });

  const subTotal =
    Math.round(lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0) * 100) / 100;

  // --- identity for the audit trail ---------------------------------------

  const u = await currentUser();
  const submittedByName =
    [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
    u?.username ||
    u?.primaryEmailAddress?.emailAddress ||
    "Portal user";

  const customerNames = await getJSON<Record<string, string>>("customerNames");

  const ref = await nextRef();
  const id = await createPortalOrder({
    ref,
    submittedAt: Date.now(),
    orgId,
    orgName: access.groupName,
    submittedByUserId: userId,
    submittedByName,
    submittedByEmail: u?.primaryEmailAddress?.emailAddress ?? null,
    debtorCode,
    debtorName: customerNames?.[debtorCode] ?? null,
    poRef,
    requiredBy,
    deliverTo,
    contact,
    phone,
    notes,
    lines,
    priceType,
    subTotal,
    duplicateOf: existingId ?? null,
  });

  return NextResponse.json({ ok: true, id, ref, subTotal, lineCount: lines.length });
}
