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

// Words that appear in half the customer file and carry no identifying signal.
// Legal suffixes and trading-name filler only — trade words like POOL are left
// to the IDF weighting below, which discounts them automatically.
const STOP_WORDS = new Set([
  "PTY", "LTD", "PTYLTD", "THE", "AND", "ATF", "TRUST", "AUSTRALIA", "AUST",
  "GROUP", "INC", "COMPANY", "TRADING", "SERVICES", "AUSTRALIAN",
]);

function nameTokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Inverse document frequency over the customer file itself. A token in many
 * customer names (POOL, POOLS, REECE, SPA, WAREHOUSE) is worth little; a rare
 * one (BERRIMAH, ROCKINGHAM, VILLAWOOD) is worth a lot. Derived from the data,
 * so it stays correct as the customer file changes — no hand-kept word list.
 */
function buildIdf(customerNames: Record<string, string>): (t: string) => number {
  const df = new Map<string, number>();
  const total = Object.keys(customerNames).length || 1;
  for (const name of Object.values(customerNames)) {
    for (const t of new Set(nameTokens(name))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return (t: string) => Math.log((total + 1) / ((df.get(t) ?? 0) + 1)) + 0.1;
}

interface AddressProfile {
  suburb?: string | null;
  city?: string | null;
  postcode?: string | null;
}

/**
 * Resolve the email to a customer account.
 *
 * Replaces the previous `hits / Math.max(probeWords, nameWords)` scoring, which
 * had two failure modes that between them mislabelled most branch orders:
 *
 *   1. A one-word probe (the mail domain, e.g. "REECE") scored highest against
 *      the SHORTEST candidate name — "REECE" vs "REECE VILLAWOOD" = 0.50, which
 *      beat the correct branch on every Reece email regardless of content.
 *   2. Legal filler counted as signal — "Pool and Spa Manufacturing Australia
 *      Pty Ltd" matched "POOL RANGER PTY LTD" on POOL/PTY/LTD at 0.43 and was
 *      written in as debtor 203400.
 *
 * Now: IDF-weighted symmetric (Jaccard) overlap so short names get no free
 * advantage, probes weighted by how much they're worth (a full company name
 * beats a bare mail domain), delivery-address confirmation against the
 * customer's own suburb/postcode to separate branches of a chain, and a floor
 * below which it reports nothing rather than something wrong.
 */
function resolveCustomer(
  companyGuess: string | null,
  fromName: string | null,
  fromEmail: string,
  deliverTo: string | null,
  customerNames: Record<string, string>,
  customerProfiles: Record<string, AddressProfile>
): {
  code: string | null;
  name: string | null;
  confidence: "high" | "low";
  candidates: { code: string; name: string; score: number }[];
} {
  const entries = Object.entries(customerNames);
  if (entries.length === 0) return { code: null, name: null, confidence: "low", candidates: [] };

  const idf = buildIdf(customerNames);
  const domainToken = norm((fromEmail.split("@")[1] ?? "").split(".")[0] ?? "");

  // A mail domain is a group-level hint at best ("reece.com.au" is true of 400
  // branches), so it's weighted well below anything naming an actual entity.
  const probes = [
    { text: companyGuess, weight: 1.0 },
    { text: fromName, weight: 0.9 },
    { text: deliverTo, weight: 0.9 },
    { text: domainToken, weight: 0.35 },
  ].filter((p) => p.text) as { text: string; weight: number }[];

  const deliverSet = new Set(nameTokens(deliverTo ?? ""));
  const deliverNorm = norm(deliverTo ?? "");

  const scored: { code: string; name: string; score: number }[] = [];

  for (const [code, name] of entries) {
    const nameToks = [...new Set(nameTokens(name))];
    if (nameToks.length === 0) continue;
    const nameWeight = nameToks.reduce((s, t) => s + idf(t), 0);

    let textScore = 0;
    for (const p of probes) {
      const pToks = [...new Set(nameTokens(p.text))];
      if (pToks.length === 0) continue;
      const probeWeight = pToks.reduce((s, t) => s + idf(t), 0);
      const sharedWeight = pToks
        .filter((t) => nameToks.includes(t))
        .reduce((s, t) => s + idf(t), 0);
      if (sharedWeight === 0) continue;
      const jaccard = sharedWeight / (probeWeight + nameWeight - sharedWeight);
      textScore = Math.max(textScore, jaccard * p.weight);
    }

    // Address confirmation. The delivery block on a branch PO names the branch
    // suburb and postcode, which is the only thing that reliably separates
    // Reece Berrimah from Reece Villawood.
    const prof = customerProfiles[code];
    let bonus = 0;
    if (prof) {
      const suburb = norm(prof.suburb ?? prof.city ?? "");
      if (suburb && suburb.split(" ").some((w) => w.length > 2 && deliverSet.has(w))) bonus += 0.3;
      if (prof.postcode && deliverNorm.includes(String(prof.postcode))) bonus += 0.2;
    }

    const score = Math.min(1, textScore + bonus);
    if (score > 0) scored.push({ code, name, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 3);
  const best = scored[0];

  // Below the floor, say nothing. A wrong debtor code is worse than a blank
  // one: it reads as resolved, it poisons the debtor+PO duplicate key, and it
  // sends the agent to the wrong account in Arrow.
  if (!best || best.score < 0.3) {
    return { code: null, name: null, confidence: "low", candidates };
  }

  // A near-tie between two different accounts is not a confident answer either.
  const runnerUp = scored[1];
  const decisive = !runnerUp || best.score - runnerUp.score >= 0.1;

  return {
    code: best.code,
    name: best.name,
    confidence: best.score >= 0.6 && decisive ? "high" : "low",
    candidates,
  };
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
  "companyGuess": string|null,        // the ORDERING entity. On a chain's purchase order this is the specific BRANCH placing the order (e.g. "Reece Irrigation & Pools Berrimah"), NOT the group letterhead at the top of the page (e.g. "Reece Australia Pty Ltd"). Look for "Purchase Branch", "Deliver to", the sending store's name, or the signature before falling back to the letterhead.
  "branchRef": string|null,           // branch name/number and its suburb, state and postcode if the document shows one (e.g. "Irrigation & Pools Berrimah #8014, 47 Pruen Road, Berrimah NT 0828")
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

  const [customerNames, customerProfiles, stockAll] = await Promise.all([
    getJSON<Record<string, string>>("customerNames"),
    getJSON<Record<string, AddressProfile>>("customerProfiles"),
    getJSON<StockRow[]>("stock:all"),
  ]);

  // deliverTo carries the branch suburb and postcode on a chain PO, which is
  // what actually distinguishes one branch account from another.
  const cust = resolveCustomer(
    extracted.companyGuess ?? null,
    body.fromName ?? null,
    body.fromEmail,
    [extracted.deliverTo, extracted.branchRef, body.subject].filter(Boolean).join(" ") || null,
    customerNames ?? {},
    customerProfiles ?? {}
  );

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
    debtorCandidates: cust.confidence === "high" ? [] : cust.candidates,
  };

  const id = await createIntake(data);

  return { ok: true, id, skipped: undefined };
}

interface ExtractedOrder {
  companyGuess?: string | null;
  branchRef?: string | null;
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
