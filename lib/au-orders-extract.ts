import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import { getJSON } from "@/lib/redis";
import { createIntake, type IntakeData, type IntakeLine } from "@/lib/au-orders-inbox";

/**
 * Shared extraction logic for the au-orders inbox. This is the SLOW part
 * (Claude call + attachment parsing) and now runs in the background worker
 * (/api/au-orders-inbox/process), NOT in the request Power Automate waits on.
 * The ingest route just queues the raw email; this turns it into an order.
 */

export interface IncomingAttachment {
  name: string;
  contentType: string;
  contentBytes: string; // base64 (Power Automate's $content)
}

export interface IngestBody {
  internetMessageId: string;
  subject?: string;
  fromEmail: string;
  fromName?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  receivedDateTime?: string | null; // ISO
  webLink?: string | null;
  attachments?: IncomingAttachment[];
}

// stock:all rows carry more than the stock/route.ts interface declares — name
// (description) and supplierStock (supplier part no.) are what search_products uses.
interface StockRow {
  sku: string;
  name?: string | null;
  supplierStock?: string | null;
  byLocation?: Record<string, { onHand: number }>;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Resolution against the portal's own data
// ---------------------------------------------------------------------------

function resolveCustomer(
  companyGuess: string | null,
  fromName: string | null,
  fromEmail: string,
  customerNames: Record<string, string>
): { code: string | null; name: string | null; confidence: "high" | "low" } {
  const entries = Object.entries(customerNames);
  if (entries.length === 0) return { code: null, name: null, confidence: "low" };

  const domainToken = norm((fromEmail.split("@")[1] ?? "").split(".")[0] ?? "");
  const probes = [companyGuess, fromName, domainToken].filter(Boolean).map((p) => norm(p as string));

  let best: { code: string; name: string; score: number } | null = null;
  for (const [code, name] of entries) {
    const nameWords = new Set(norm(name).split(" ").filter((w) => w.length > 2));
    if (nameWords.size === 0) continue;
    for (const probe of probes) {
      const probeWords = probe.split(" ").filter((w) => w.length > 2);
      if (probeWords.length === 0) continue;
      const hits = probeWords.filter((w) => nameWords.has(w)).length;
      const score = hits / Math.max(probeWords.length, nameWords.size);
      if (score > 0 && (!best || score > best.score)) best = { code, name, score };
    }
  }
  if (!best) return { code: null, name: null, confidence: "low" };
  // A strong overlap is a confident match; a weak one is a hint a human should confirm.
  return { code: best.code, name: best.name, confidence: best.score >= 0.6 ? "high" : "low" };
}

function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > cap) return cap + 1; // early out
  }
  return prev[b.length];
}

// Find up to 3 stock codes that are near the customer's code (prefix or small
// edit distance). Used only when there's no exact match, to offer the agent a
// "did you mean" they can click to accept. Never auto-fills.
function closeMatches(
  code: string,
  stockAll: StockRow[]
): { sku: string; description: string | null }[] {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length < 4) return [];
  const cap = Math.max(1, Math.floor(c.length * 0.2)); // tolerate ~20% difference
  const scored: { sku: string; description: string | null; d: number }[] = [];
  for (const r of stockAll) {
    for (const cand of [r.sku, r.supplierStock]) {
      if (!cand) continue;
      const s = cand.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!s || Math.abs(s.length - c.length) > cap) continue;
      let d: number;
      if (s === c) d = 0;
      else if (s.startsWith(c) || c.startsWith(s)) d = Math.abs(s.length - c.length);
      else d = levenshtein(c, s, cap);
      if (d <= cap) { scored.push({ sku: r.sku, description: r.name ?? null, d }); break; }
    }
  }
  scored.sort((a, b) => a.d - b.d);
  const seen = new Set<string>();
  const out: { sku: string; description: string | null }[] = [];
  for (const x of scored) {
    if (seen.has(x.sku)) continue;
    seen.add(x.sku);
    out.push({ sku: x.sku, description: x.description });
    if (out.length >= 3) break;
  }
  return out;
}

function matchSku(
  rawLine: string,
  skuLiteral: string | null,
  stockAll: StockRow[]
): { sku: string | null; description: string | null; confidence: "high" | "low"; suggestions: { sku: string; description: string | null }[] } {
  // Pull every plausible product code out of the line — the customer's explicit
  // skuLiteral, plus any token that looks like a part number (has a digit, >=5
  // chars). Strips vendor-part markers like "V.PN#" / "PN#" that wrap the real
  // Hayward code, and trailing punctuation. The buried "20-HWX200036005" in a
  // messy line gets caught here.
  const candidates: string[] = [];
  const push = (c: string | null | undefined) => {
    if (!c) return;
    let t = String(c).toUpperCase().trim();
    t = t.replace(/^V\.?\s*PN\s*#?/, "").replace(/^PN\s*#/, ""); // drop vendor-part markers
    t = t.replace(/^[^A-Z0-9]+/, "").replace(/[^A-Z0-9-]+$/, ""); // trim edge punctuation
    if (t.length >= 5 && /\d/.test(t) && /[A-Z0-9]/.test(t)) candidates.push(t);
  };
  push(skuLiteral);
  for (const tok of rawLine.split(/[\s,;]+/)) push(tok);

  // 1. Exact match of any candidate against a real sku or supplier part no. → high.
  for (const c of candidates) {
    const exact = stockAll.find(
      (r) => r.sku.toUpperCase() === c || (r.supplierStock ?? "").toUpperCase() === c
    );
    if (exact) return { sku: exact.sku, description: exact.name ?? null, confidence: "high", suggestions: [] };
  }

  // No exact match — compute "did you mean" suggestions from the best candidate
  // code(s) so the agent can click to accept. Never auto-fills.
  let suggestions: { sku: string; description: string | null }[] = [];
  for (const c of candidates) {
    suggestions = closeMatches(c, stockAll);
    if (suggestions.length) break;
  }

  // 2. Fallback: word match over the DESCRIPTION words (ignore qty/price/EA noise).
  const words = norm(rawLine)
    .split(" ")
    .filter((w) => w.length > 2 && w !== "EA" && !/^\d+([.,]\d+)?$/.test(w));
  if (words.length === 0) return { sku: null, description: null, confidence: "low", suggestions };
  const hits = stockAll.filter((r) => {
    const hay = `${r.sku} ${r.name ?? ""} ${r.supplierStock ?? ""}`.toUpperCase();
    return words.every((w) => hay.includes(w));
  });
  if (hits.length === 1) return { sku: hits[0].sku, description: hits[0].name ?? null, confidence: "high", suggestions: [] };
  if (hits.length > 1) {
    // Ambiguous — don't guess. Offer the word-match hits (plus any code suggestions) to pick from.
    const wordSug = hits.slice(0, 3).map((r) => ({ sku: r.sku, description: r.name ?? null }));
    const merged = [...suggestions, ...wordSug].filter(
      (s, i, a) => a.findIndex((x) => x.sku === s.sku) === i
    ).slice(0, 3);
    return { sku: null, description: null, confidence: "low", suggestions: merged };
  }
  return { sku: null, description: null, confidence: "low", suggestions };
}

// ---------------------------------------------------------------------------
// Build Claude content from the email + attachments
// ---------------------------------------------------------------------------

function attachmentBlocks(attachments: IncomingAttachment[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const att of attachments.slice(0, 6)) {
    const type = (att.contentType || "").toLowerCase();
    const name = (att.name || "").toLowerCase();
    // Guard: a single huge attachment is what stalls the Claude call for minutes.
    // base64 is ~4/3 the decoded size, so ~5MB decoded ≈ 6.67MB of base64 chars.
    const approxBytes = (att.contentBytes?.length ?? 0) * 0.75;
    if (approxBytes > 5_000_000) {
      blocks.push({ type: "text", text: `Attachment "${att.name}" skipped — too large to parse inline (${Math.round(approxBytes / 1e6)}MB). Key this line manually from the email.` });
      continue;
    }
    try {
      if (type.includes("pdf") || name.endsWith(".pdf")) {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: att.contentBytes } });
      } else if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/.test(name)) {
        const media = type.startsWith("image/") ? type : "image/png";
        blocks.push({ type: "image", source: { type: "base64", media_type: media as "image/png", data: att.contentBytes } });
      } else if (/spreadsheet|excel|csv/.test(type) || /\.(xlsx?|csv)$/.test(name)) {
        const wb = XLSX.read(Buffer.from(att.contentBytes, "base64"), { type: "buffer" });
        const csv = wb.SheetNames.map((s) => `# ${s}\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`).join("\n\n");
        blocks.push({ type: "text", text: `Attachment "${att.name}" (spreadsheet, as CSV):\n${csv.slice(0, 20000)}` });
      }
    } catch {
      blocks.push({ type: "text", text: `Attachment "${att.name}" could not be parsed automatically.` });
    }
  }
  return blocks;
}

const SYSTEM = `You extract a sales order from a customer email sent to a pool-equipment distributor's orders inbox. Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "companyGuess": string|null,        // the customer's company name if you can tell (from signature, domain, letterhead)
  "poRef": string|null,               // the customer's own PO / order reference number
  "deliverBy": string|null,           // requested delivery date or text
  "deliverTo": string|null,           // delivery address or "pickup"
  "contact": string|null,             // contact name / phone
  "notes": string|null,               // anything important (ship complete, urgency, queries)
  "isOrder": boolean,                 // false if this is not actually an order (enquiry, spam, reply)
  "lines": [
    { "raw": string,                  // the line exactly as the customer wrote it
      "qty": number|null,
      "unit": string|null,
      "skuLiteral": string|null,      // an explicit product code the customer wrote. Prefer a vendor/Hayward part number (often written like "V.PN#20-HWX200036005", "20-HWX...", "1B-SP...", "1C-..."). Extract just the code (e.g. "20-HWX200036005"), not the "V.PN#" prefix. Null only if no code is present.
      "claimedPrice": number|null }   // a price the customer stated, if any
  ]
}

Rules: never invent product codes — only put something in skuLiteral if the customer actually wrote a code. Keep "raw" verbatim. If you are unsure whether it's an order, set isOrder false rather than guessing.`;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export type IntakeResult =
  | { ok: true; id?: string; skipped?: string }
  | { ok: false; error: string };

export async function processRawIntake(body: IngestBody): Promise<IntakeResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  }

  const emailText =
    `Subject: ${body.subject ?? ""}\nFrom: ${body.fromName ?? ""} <${body.fromEmail}>\n` +
    `Received: ${body.receivedDateTime ?? ""}\n\n${body.bodyText ?? stripHtml(body.bodyHtml) ?? ""}`;

  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: emailText },
    ...attachmentBlocks(body.attachments ?? []),
  ];

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 1,      // don't multiply a slow call into 3x the wait
    timeout: 120_000,   // 2-min hard cap; a stalled extraction fails cleanly, not after 10+ min
  });
  let extracted: ExtractedOrder;
  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
    extracted = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { ok: false, error: "extraction_failed: " + String(e) };
  }

  if (extracted.isOrder === false) {
    return { ok: true, skipped: "not_an_order" };
  }

  const [customerNames, stockAll] = await Promise.all([
    getJSON<Record<string, string>>("customerNames"),
    getJSON<StockRow[]>("stock:all"),
  ]);

  const cust = resolveCustomer(extracted.companyGuess ?? null, body.fromName ?? null, body.fromEmail, customerNames ?? {});

  const lines: IntakeLine[] = (extracted.lines ?? []).map((l) => {
    const m = matchSku(l.raw, l.skuLiteral ?? null, stockAll ?? []);
    return {
      raw: l.raw,
      sku: m.sku,
      description: m.description,
      qty: l.qty ?? null,
      unit: l.unit ?? null,
      claimedPrice: l.claimedPrice ?? null,
      confidence: m.sku ? m.confidence : "low",
      suggestions: m.sku ? [] : m.suggestions,
    };
  });

  const allResolved = cust.confidence === "high" && lines.length > 0 && lines.every((l) => l.sku && l.confidence === "high");

  const data: IntakeData = {
    internetMessageId: body.internetMessageId,
    receivedAt: body.receivedDateTime ? Date.parse(body.receivedDateTime) : Date.now(),
    emailWebUrl: body.webLink ?? null,
    fromEmail: body.fromEmail,
    fromName: body.fromName ?? null,
    debtorCode: cust.code,
    debtorName: cust.name,
    poRef: extracted.poRef ?? null,
    deliverBy: extracted.deliverBy ?? null,
    deliverTo: extracted.deliverTo ?? null,
    contact: extracted.contact ?? null,
    lines,
    notes: extracted.notes ?? null,
    extractionConfidence: allResolved ? "high" : "low",
    duplicateOf: null, // createIntake fills this from debtor + PO
  };

  const id = await createIntake(data);

  return { ok: true, id, skipped: undefined };
}

interface ExtractedOrder {
  companyGuess?: string | null;
  poRef?: string | null;
  deliverBy?: string | null;
  deliverTo?: string | null;
  contact?: string | null;
  notes?: string | null;
  isOrder?: boolean;
  lines?: { raw: string; qty?: number | null; unit?: string | null; skuLiteral?: string | null; claimedPrice?: number | null }[];
}

function stripHtml(html?: string | null): string | null {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
