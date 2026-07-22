import { NextResponse } from "next/server";
import { getCustomerAccess } from "@/lib/access";
import { customerStatus, listOrdersForCustomer } from "@/lib/portal-orders";

export const dynamic = "force-dynamic";

/**
 * GET /api/my-orders
 *
 * A customer's own portal-submitted orders and where each one has got to.
 * Without this, submitting an order on the portal is worse than emailing one —
 * at least an email leaves a sent item. This is the receipt.
 *
 * Scoped to the caller's own customerCodes, so it is safe for non-staff logins.
 * The internal workflow (who claimed it, agent notes) is deliberately NOT
 * returned; only the customer-facing status.
 */
export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: "No organization selected" }, { status: 403 });
  }

  // An aggregate (staff) login holds every code in the business; fanning out
  // over all of them would be a pointless read. Staff have their own queue page.
  if (access.isAggregate) {
    return NextResponse.json({ orders: [], isAggregate: true });
  }

  const records = await listOrdersForCustomer(access.customerCodes, 25);

  const orders = records.map((o) => {
    const status = customerStatus(o);
    return {
      id: o.id,
      ref: o.ref,
      poRef: o.poRef,
      debtorCode: o.debtorCode,
      debtorName: o.debtorName,
      submittedAt: o.submittedAt,
      submittedByName: o.submittedByName,
      lineCount: o.lines.length,
      subTotal: o.subTotal,
      requiredBy: o.requiredBy,
      statusLabel: status.label,
      statusDetail: status.detail,
    };
  });

  return NextResponse.json({ orders, isAggregate: false });
}
