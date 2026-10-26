/**
 * lib/mail — outbound email from the portal (runs on Vercel, so no SMTP
 * socket, no nodemailer; both providers are plain HTTPS calls).
 *
 * Provider is picked by env — set ONE of these on Vercel:
 *
 *   MAIL_PROVIDER=resend
 *     RESEND_API_KEY=re_...
 *     MAIL_FROM="Hayward Portal <orders@portal-hayward.com>"
 *     (verify portal-hayward.com in Resend → Domains; the DNS lives in
 *      Cloudflare already, so this needs no one outside IT.)
 *
 *   MAIL_PROVIDER=graph
 *     GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET
 *       Entra app registration, client-credentials, APPLICATION permission
 *       Mail.Send with admin consent (the same registration planned for
 *       reading Dimi's mailbox can carry this).
 *     MAIL_FROM=au-orders@hayward.com   (the mailbox the app sends AS)
 *
 * MAIL_PROVIDER unset → sendMail() logs and returns { ok:false, skipped:true }.
 * Nothing in here throws: a failed notification must never fail the thing
 * that triggered it (an order is already stored by the time we get here).
 */

export interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface MailResult {
  ok: boolean;
  provider: "resend" | "graph" | "none";
  id?: string;
  error?: string;
  skipped?: boolean;
}

const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);

export function mailConfigured(): boolean {
  const p = (process.env.MAIL_PROVIDER || "").toLowerCase();
  if (p === "resend") return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
  if (p === "graph") {
    return !!(
      process.env.GRAPH_TENANT_ID &&
      process.env.GRAPH_CLIENT_ID &&
      process.env.GRAPH_CLIENT_SECRET &&
      process.env.MAIL_FROM
    );
  }
  return false;
}

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  const provider = (process.env.MAIL_PROVIDER || "").toLowerCase();
  try {
    if (provider === "resend") return await viaResend(msg);
    if (provider === "graph") return await viaGraph(msg);
    console.warn(`[mail] MAIL_PROVIDER not set — not sending "${msg.subject}" to ${list(msg.to).join(", ")}`);
    return { ok: false, provider: "none", skipped: true, error: "MAIL_PROVIDER not set" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[mail] ${provider} failed for "${msg.subject}": ${error}`);
    return { ok: false, provider: provider === "graph" ? "graph" : "resend", error };
  }
}

// --- Resend -----------------------------------------------------------------

async function viaResend(msg: MailMessage): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) throw new Error("RESEND_API_KEY / MAIL_FROM missing");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: list(msg.to),
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      reply_to: msg.replyTo,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`);
  return { ok: true, provider: "resend", id: body?.id };
}

// --- Microsoft Graph --------------------------------------------------------

async function graphToken(): Promise<string> {
  const tenant = process.env.GRAPH_TENANT_ID;
  const id = process.env.GRAPH_CLIENT_ID;
  const secret = process.env.GRAPH_CLIENT_SECRET;
  if (!tenant || !id || !secret) throw new Error("GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET missing");
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) throw new Error(`Graph token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token as string;
}

async function viaGraph(msg: MailMessage): Promise<MailResult> {
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error("MAIL_FROM missing");
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: { contentType: "HTML", content: msg.html },
        toRecipients: list(msg.to).map((address) => ({ emailAddress: { address } })),
        ...(msg.replyTo ? { replyTo: [{ emailAddress: { address: msg.replyTo } }] } : {}),
      },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202) throw new Error(`Graph sendMail ${res.status}: ${await res.text()}`);
  return { ok: true, provider: "graph" };
}
