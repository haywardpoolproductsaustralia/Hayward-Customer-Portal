import "server-only";

/**
 * Server-only Freshdesk client.
 * The API key NEVER reaches the browser — this module is import-guarded
 * with "server-only" and is only ever called from route handlers.
 *
 * Required env var:  FRESHDESK_API_KEY
 * Optional env var:  FRESHDESK_DOMAIN  (defaults to hayward9702.freshdesk.com)
 */

const DOMAIN = process.env.FRESHDESK_DOMAIN ?? "hayward9702.freshdesk.com";
const API_KEY = process.env.FRESHDESK_API_KEY;
const BASE = `https://${DOMAIN}/api/v2`;

export type FreshdeskTicket = {
  id: number;
  subject: string;
  status: number;
  priority: number;
  type: string | null;
  created_at: string;
  updated_at: string;
  requester_id: number;
};

export const STATUS_LABELS: Record<number, string> = {
  2: "Open",
  3: "Pending",
  4: "Resolved",
  5: "Closed",
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Urgent",
};

function authHeader(): string {
  if (!API_KEY) throw new Error("FRESHDESK_API_KEY is not set");
  // Freshdesk basic auth = base64("APIKEY:X")
  const token = Buffer.from(`${API_KEY}:X`).toString("base64");
  return `Basic ${token}`;
}

async function fd(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Freshdesk ${res.status}: ${body}`);
  }
  return res;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * List tickets for a requester by email.
 * Uses the plain /tickets list filter — does NOT burn the search rate limit.
 */
export async function listTicketsByEmail(
  email: string
): Promise<FreshdeskTicket[]> {
  const res = await fd(
    `/tickets?email=${encodeURIComponent(
      email
    )}&order_by=created_at&order_type=desc&per_page=50`
  );
  return res.json();
}

export async function createTicket(input: {
  email: string;
  subject: string;
  description: string; // plain text — converted to HTML here
  type?: string;
  priority?: number;
}) {
  const html = `<div>${escapeHtml(input.description).replace(/\n/g, "<br/>")}</div>`;
  const res = await fd(`/tickets`, {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      subject: input.subject,
      description: html,
      status: 2, // Open
      priority: input.priority ?? 1, // Low
      source: 2, // Portal
      type: input.type ?? "Question",
    }),
  });
  return res.json();
}

/**
 * Fetch one ticket with its conversation thread AND requester, so the caller
 * can verify ownership (prevents ID enumeration / IDOR).
 */
export async function getTicket(id: number) {
  const res = await fd(`/tickets/${id}?include=conversations,requester`);
  return res.json();
}
