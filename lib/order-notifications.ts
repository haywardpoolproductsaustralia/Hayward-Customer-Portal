import { redis } from "@/lib/redis";
import { sendMail } from "@/lib/mail";
import type { PortalOrderData } from "@/lib/portal-orders";

/**
 * Staff notification: "a new portal order has been placed".
 *
 * Sent to the AU orders mailbox the moment an order is stored by
 * POST /api/orders/submit. This is NOT the customer acknowledgement (that
 * goes out later, once the Arrow packing slip exists) — it's the nudge that
 * tells the order desk there is something in the Portal orders queue.
 *
 * Recipient:  ORDER_NOTIFY_TO  (default au-orders@hayward.com; comma-separated
 *             for more than one)
 * Deep link:  NEXT_PUBLIC_PORTAL_URL (default https://portal-hayward.com)
 *
 * Failures are logged to Redis (`pso:notify:failed`, newest first, capped) so
 * they can be checked — the order itself is never rolled back or failed.
 */

const DEFAULT_TO = "au-orders@hayward.com";
const FAILED_KEY = "pso:notify:failed";
const FAILED_CAP = 200;

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const money = (n: number | null) => (n == null ? "—" : AUD.format(n));

const esc = (s: string | null | undefined) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function melbourne(ts: number): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ts));
}

export function notifyRecipients(): string[] {
  return (process.env.ORDER_NOTIFY_TO || DEFAULT_TO)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildNewOrderEmail(order: PortalOrderData, id: string) {
  const portal = (process.env.NEXT_PUBLIC_PORTAL_URL || "https://portal-hayward.com").replace(/\/$/, "");
  const queueUrl = `${portal}/dashboard/portal-orders`;
  const account = `${order.debtorCode}${order.debtorName ? ` — ${order.debtorName}` : ""}`;
  const mismatches = order.lines.filter((l) => l.priceMismatch).length;
  const totalQty = order.lines.reduce((s, l) => s + l.qty, 0);

  const subject = `New portal order ${order.ref} — ${order.debtorName ?? order.debtorCode} — PO ${order.poRef}`;

  const rows = order.lines
    .map(
      (l) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-family:monospace">${esc(l.sku)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(l.description)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${l.qty}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${money(l.unitPriceServer)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${money(l.lineTotal)}${
            l.priceMismatch ? ' <span style="color:#E11D48;font-weight:600">⚠</span>' : ""
          }</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;color:#64748b">${
            l.onHandAtSubmit ?? "—"
          }</td>
        </tr>`
    )
    .join("");

  const kv = (k: string, v: string | null | undefined) =>
    v
      ? `<tr><td style="padding:3px 12px 3px 0;color:#64748b;white-space:nowrap">${k}</td><td style="padding:3px 0">${esc(v)}</td></tr>`
      : "";

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0F172A;max-width:760px">
  <div style="background:#075985;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
    <div style="font-size:12px;opacity:.85;letter-spacing:.04em;text-transform:uppercase">Hayward Customer Portal</div>
    <div style="font-size:18px;font-weight:600;margin-top:2px">New order placed — ${esc(order.ref)}</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:0;padding:16px 18px;border-radius:0 0 8px 8px">
    <table style="border-collapse:collapse;font-size:14px;margin-bottom:14px">
      ${kv("Account", account)}
      ${kv("Customer PO", order.poRef)}
      ${kv("Placed", `${melbourne(order.submittedAt)} by ${order.submittedByName}${
        order.submittedByEmail ? ` (${order.submittedByEmail})` : ""
      }`)}
      ${kv("Organisation", order.orgName)}
      ${kv("Required by", order.requiredBy)}
      ${kv("Deliver to", order.deliverTo)}
      ${kv("Contact", [order.contact, order.phone].filter(Boolean).join(" · ") || null)}
      ${kv("Notes", order.notes)}
      ${kv("Price type", order.priceType)}
    </table>

    ${
      mismatches
        ? `<div style="background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:12px">
             ${mismatches} line${mismatches === 1 ? "" : "s"} where the quoted price differs from the server price — review before export.
           </div>`
        : ""
    }

    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#F0F9FF;text-align:left">
          <th style="padding:6px 8px">SKU</th>
          <th style="padding:6px 8px">Description</th>
          <th style="padding:6px 8px;text-align:right">Qty</th>
          <th style="padding:6px 8px;text-align:right">Unit</th>
          <th style="padding:6px 8px;text-align:right">Line</th>
          <th style="padding:6px 8px;text-align:right">On hand</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="padding:8px;font-weight:600">${order.lines.length} line${
            order.lines.length === 1 ? "" : "s"
          } · ${totalQty} units</td>
          <td colspan="3" style="padding:8px;text-align:right;font-weight:600">Subtotal ${money(order.subTotal)} ex GST</td>
          <td></td>
        </tr>
      </tfoot>
    </table>

    <p style="margin:18px 0 6px">
      <a href="${queueUrl}" style="display:inline-block;background:#0EA5E9;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600;font-size:14px">Open the Portal orders queue</a>
    </p>
    <p style="font-size:12px;color:#64748b;margin:6px 0 0">
      Order id ${esc(id)}. Export it to the Arrow sales-order CSV from the queue; the customer gets their acknowledgement once the packing slip exists.
    </p>
  </div>
</div>`;

  const text = [
    `New portal order ${order.ref}`,
    `Account: ${account}`,
    `Customer PO: ${order.poRef}`,
    `Placed: ${melbourne(order.submittedAt)} by ${order.submittedByName}`,
    order.requiredBy ? `Required by: ${order.requiredBy}` : null,
    order.deliverTo ? `Deliver to: ${order.deliverTo}` : null,
    order.notes ? `Notes: ${order.notes}` : null,
    "",
    ...order.lines.map((l) => `${l.sku.padEnd(16)} x${String(l.qty).padStart(5)}  ${money(l.lineTotal)}  ${l.description ?? ""}`),
    "",
    `Subtotal ${money(order.subTotal)} ex GST`,
    queueUrl,
  ]
    .filter((s) => s != null)
    .join("\n");

  return { subject, html, text };
}

/**
 * Fire the notification for a just-created order. Safe to call without
 * awaiting; never throws.
 */
export async function notifyNewPortalOrder(order: PortalOrderData, id: string): Promise<void> {
  try {
    const { subject, html, text } = buildNewOrderEmail(order, id);
    const result = await sendMail({
      to: notifyRecipients(),
      subject,
      html,
      text,
      replyTo: order.submittedByEmail ?? undefined,
    });
    if (result.ok) {
      console.log(`[orders] notified ${notifyRecipients().join(", ")} of ${order.ref} via ${result.provider}`);
      return;
    }
    await recordFailure(order.ref, id, result.error ?? "unknown");
  } catch (e) {
    await recordFailure(order.ref, id, e instanceof Error ? e.message : String(e));
  }
}

async function recordFailure(ref: string, id: string, error: string) {
  console.error(`[orders] notification for ${ref} failed: ${error}`);
  try {
    await redis.lpush(FAILED_KEY, JSON.stringify({ ref, id, error, at: Date.now() }));
    await redis.ltrim(FAILED_KEY, 0, FAILED_CAP - 1);
  } catch {
    /* logging only */
  }
}
