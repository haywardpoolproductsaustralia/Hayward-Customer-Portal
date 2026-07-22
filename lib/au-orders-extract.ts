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
/* ===========================================================================
   Customer resolution.

   Address-first, deliberately. The previous version scored on the company
   name and treated the address as a tie-breaker, which had it backwards:

     * An incoming order NEVER contains our customer code. Verified against
       every PDF and email body received — a customer sends their identifiers,
       not ours. So the code has to be derived from something on the document.
     * DRSMAST.CUSTOMER_NAME is char(30) and Arrow truncates to fit, so the
       word that identifies a branch is frequently cut off entirely
       ("REECE IRRIGATION & POOLS CAMPBELLTOWN" is stored as "...CAMPB").
       Names are the LEAST reliable field available.
     * The delivery block and branch phone are present on essentially every
       purchase order, and Arrow holds the same details for every account in
       DRSMAST and DELMAST. That is the real join.

   So: phone, then street, then postcode/suburb decide the match. The name is
   corroboration only, and can never carry a match on its own beyond a
   deliberately capped, never-confident score. This is general — it is not
   tuned for any one customer.
   =========================================================================== */

// Legal filler and trading-name noise. Trade words (POOL, SPA) are left to the
// IDF weighting, which discounts them from the data rather than by hand.
const STOP_WORDS = new Set([
  "PTY", "LTD", "PTYLTD", "THE", "AND", "ATF", "TRUST", "AUSTRALIA", "AUST",
  "GROUP", "INC", "COMPANY", "TRADING", "SERVICES", "AUSTRALIAN",
]);

// Street types, states and postal noise. These appear in almost every address
// and identify nothing, so they must not count as a match.
const ADDRESS_STOP = new Set([
  "ROAD", "RD", "STREET", "ST", "AVENUE", "AVE", "DRIVE", "DR", "HIGHWAY",
  "HWY", "COURT", "CRT", "CT", "PLACE", "PL", "LANE", "LN", "PARADE", "PDE",
  "CRESCENT", "CRES", "CIRCUIT", "CCT", "BOULEVARD", "BVD", "TERRACE", "TCE",
  "WAY", "CLOSE", "ESPLANADE", "UNIT", "SUITE", "LEVEL", "SHOP", "FACTORY",
  "WAREHOUSE", "BOX", "POBOX", "NSW", "VIC", "QLD", "WA", "SA", "NT", "TAS",
  "ACT", "AUSTRALIA", "NEW", "ZEALAND", "NZ", "DELIVER", "DELIVERY", "ADDRESS",
  "ATTN", "ATTENTION", "PHONE", "FAX", "BRANCH", "STORE", "DEPOT", "NORTH",
  "SOUTH", "EAST", "WEST", "UPPER", "LOWER", "MOUNT", "PORT", "PARK",
]);

function nameTokens(s: string): string[] {
  return norm(s).split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** IDF over any corpus of token lists. A token in many records is worth
 *  little; a rare one is worth a lot. Derived from the data, so it stays
 *  correct as the customer file changes — no hand-kept weighting. */
function buildIdf(docs: string[][]): (t: string) => number {
  const df = new Map<string, number>();
  const total = docs.length || 1;
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return (t: string) => Math.log((total + 1) / ((df.get(t) ?? 0) + 1)) + 0.1;
}

interface AddressProfile {
  name?: string | null;
  street?: string | null;
  suburb?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  phone?: string | null;
  /** DRSMAST.DELETE_CUSTOMER — kept in cache so it mirrors Arrow, skipped here. */
  deleted?: boolean;
  /** DELMAST. A chain can order under one debtor code but ship to many sites,
   *  so the delivery block often matches one of these, not the registered address. */
  deliveryAddresses?: { address?: string | null; phone?: string | null }[] | null;
}

/** Last 8 digits of every phone-shaped number in a blob of text. Eight digits
 *  ignores country/area-code formatting differences while staying specific. */
function phoneKeys(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  for (const m of String(s).matchAll(/[\d][\d\s()+-]{7,}/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 8) out.add(d.slice(-8));
  }
  return out;
}

interface AddressFacts {
  phones: Set<string>;
  postcodes: Set<string>;
  /** Street numbers — "65-67 Batt St" yields 65 and 67. */
  numbers: Set<string>;
  /** Locality and street-name words, with street types and states removed. */
  words: Set<string>;
  /** The address is a postal box, not a physical site. */
  poBoxOnly: boolean;
}

function addressFacts(text: string | null | undefined): AddressFacts {
  const n = norm(text ?? "");
  const words = new Set(
    n.split(" ").filter((w) => w.length > 2 && !ADDRESS_STOP.has(w) && !/^\d+$/.test(w))
  );
  const postcodes = new Set(n.match(/\b\d{4}\b/g) ?? []);

  // Street numbers must EXCLUDE the postcode. A 4-digit postcode also matches
  // a street-number pattern, so counting it as one made "street number agrees"
  // true for every pair that merely shared a postcode — which fired the top
  // confidence tier on unrelated businesses in the same suburb.
  const numbers = new Set(
    (n.match(/\b\d{1,5}\b/g) ?? []).filter((d) => !postcodes.has(d))
  );

  // A PO Box identifies a mail drop, not a site. Two different businesses
  // collecting mail in the same town look identical on this evidence, so it
  // must never reach the confidence a real street address does.
  const poBoxOnly = /\bP\s?O\s?BOX\b|\bPOBOX\b|\bLOCKED\s?BAG\b|\bPRIVATE\s?BAG\b/.test(n);

  return { phones: phoneKeys(text), postcodes, numbers, words, poBoxOnly };
}

/** All the address text Arrow holds for one account: its registered address
 *  plus every delivery address on file. */
function profileAddressText(p: AddressProfile | undefined): string {
  if (!p) return "";
  const own = [p.street, p.suburb, p.city, p.state, p.postcode, p.phone].filter(Boolean).join(" ");
  const del = (p.deliveryAddresses ?? [])
    .map((d) => [d.address, d.phone].filter(Boolean).join(" "))
    .join(" ");
  return `${own} ${del}`;
}

/* Parsing the address of every account is the expensive part, and it depends
   only on the customer file — not on the order being matched. Doing it per
   order would mean ~3,000 accounts re-parsed for every email in the queue.
   Built once and reused until the customer file changes. */
interface CustomerIndex {
  entries: { code: string; name: string; facts: AddressFacts; nameToks: string[]; stub: string | null }[];
  addrIdf: (t: string) => number;
  nameIdf: (t: string) => number;
  /** How many accounts carry each phone number. Head-office and franchise
   *  numbers are shared by many accounts, so a phone hit is only decisive when
   *  the number belongs to exactly one. */
  phoneOwners: Map<string, number>;
}
let indexCache: { key: string; index: CustomerIndex } | null = null;

function buildCustomerIndex(
  customerNames: Record<string, string>,
  customerProfiles: Record<string, AddressProfile>
): CustomerIndex {
  const codes = Object.keys(customerNames);
  // Cheap identity for the cache: a full hash would cost more than it saves,
  // and the sync replaces the whole map at once, so size plus endpoints is
  // enough to notice a new snapshot.
  const key = `${codes.length}:${codes[0] ?? ""}:${codes[codes.length - 1] ?? ""}`;
  if (indexCache?.key === key) return indexCache.index;

  const entries = codes.map((code) => {
    const name = customerNames[code];
    const nameToks = [...new Set(nameTokens(name))];
    // CUSTOMER_NAME is char(30) and Arrow truncates, so the final token of a
    // name at the cap is a stub of the real word.
    const truncated = name.trim().length >= 30;
    return {
      code,
      name,
      facts: addressFacts(profileAddressText(customerProfiles[code])),
      nameToks,
      stub: truncated && nameToks.length ? nameToks[nameToks.length - 1] : null,
    };
  });

  const phoneOwners = new Map<string, number>();
  for (const e of entries) {
    for (const k of e.facts.phones) phoneOwners.set(k, (phoneOwners.get(k) ?? 0) + 1);
  }

  const index: CustomerIndex = {
    entries,
    phoneOwners,
    // IDF over locality/street words across the whole customer file, so common
    // words (INDUSTRIAL, CENTRAL, a suburb shared by many accounts) can't carry
    // a match while a distinctive one can.
    addrIdf: buildIdf(entries.map((e) => [...e.facts.words])),
    nameIdf: buildIdf(entries.map((e) => e.nameToks)),
  };
  indexCache = { key, index };
  return index;
}

function resolveCustomer(
  companyGuess: string | null,
  fromName: string | null,
  fromEmail: string,
  orderAddressText: string | null,
  customerNames: Record<string, string>,
  customerProfiles: Record<string, AddressProfile>
): {
  code: string | null;
  name: string | null;
  confidence: "high" | "low";
  candidates: { code: string; name: string; score: number; why: string }[];
} {
  if (Object.keys(customerNames).length === 0) {
    return { code: null, name: null, confidence: "low", candidates: [] };
  }

  const want = addressFacts(orderAddressText);
  const { entries, addrIdf, nameIdf, phoneOwners } = buildCustomerIndex(customerNames, customerProfiles);

  const domainToken = norm((fromEmail.split("@")[1] ?? "").split(".")[0] ?? "");
  // Probe tokens are the same for every candidate, so tokenise once.
  const probeTokenSets = [companyGuess, fromName, domainToken]
    .filter(Boolean)
    .map((p) => [...new Set(nameTokens(p as string))])
    .filter((t) => t.length > 0);

  const scored: { code: string; name: string; score: number; why: string }[] = [];

  for (const entry of entries) {
    const { code, name } = entry;
    const prof = customerProfiles[code];
    if (prof?.deleted) continue; // can't be ordered against

    const have = entry.facts; // precomputed in the index

    /* ---- 1. Phone — but only decisive when the number is unique.
             838 of ~3,200 accounts share a phone with another account
             (franchise head offices, group switchboards, duplicated records).
             A shared number narrows the field; it does not identify anyone. -- */
    let addrScore = 0;
    let why = "";
    let sharedPhoneHit = false;
    for (const k of want.phones) {
      if (!have.phones.has(k)) continue;
      const owners = phoneOwners.get(k) ?? 1;
      if (owners === 1) { addrScore = 0.95; why = "unique phone match"; }
      else { sharedPhoneHit = true; }
      break;
    }

    /* ---- 2. Address. Postcode plus a distinctive locality/street word, with
             a genuine street number as extra confirmation. ---------------- */
    if (addrScore === 0) {
      const pcHit = [...want.postcodes].some((p) => have.postcodes.has(p));
      const sharedWords = [...want.words].filter((w) => have.words.has(w));
      const sharedWeight = sharedWords.reduce((s, w) => s + addrIdf(w), 0);
      // Street numbers only. Postcodes are excluded in addressFacts, and a
      // single digit is too common to mean anything.
      const numHit = [...want.numbers].some((nm) => nm.length >= 2 && have.numbers.has(nm));

      // Weight thresholds rather than counts, so two generic words don't beat
      // one highly distinctive one.
      const strongWord = sharedWeight >= 3.0;
      const someWord = sharedWeight >= 1.5;

      if (pcHit && strongWord && numHit) { addrScore = 0.95; why = "postcode + street + number"; }
      else if (pcHit && strongWord)      { addrScore = 0.88; why = "postcode + locality"; }
      else if (pcHit && someWord)        { addrScore = 0.75; why = "postcode + partial address"; }
      else if (strongWord && numHit)     { addrScore = 0.70; why = "street + number"; }
      else if (strongWord)               { addrScore = 0.55; why = "distinctive locality"; }
      else if (pcHit)                    { addrScore = 0.30; why = "postcode only"; }

      // A postal box plus a town is not a site. Cap it below the confidence
      // threshold so it can never resolve on its own — two unrelated
      // businesses collecting mail in the same town are indistinguishable.
      if ((want.poBoxOnly || have.poBoxOnly) && addrScore > 0.70) {
        addrScore = 0.70;
        why += " (PO box — not a site)";
      }

      // A shared phone is real corroboration, just not proof on its own.
      if (sharedPhoneHit && addrScore > 0) {
        addrScore = Math.min(0.92, addrScore + 0.1);
        why += " + shared phone";
      } else if (sharedPhoneHit) {
        addrScore = 0.35;
        why = "shared phone only";
      }
    }

    /* ---- 3. Name. Corroboration only. Prefix-matched against the final token
             of any name sitting at Arrow's char(30) cap, since that token is a
             stub of the real word. ---------------------------------------- */
    const { nameToks, stub } = entry; // precomputed in the index
    let nameFit = 0;
    if (nameToks.length) {
      const nameWeight = nameToks.reduce((s, t) => s + nameIdf(t), 0);
      for (const pToks of probeTokenSets) {
        const probeWeight = pToks.reduce((s, t) => s + nameIdf(t), 0);
        let shared = 0;
        for (const t of pToks) {
          if (nameToks.includes(t)) shared += nameIdf(t);
          else if (stub && stub.length >= 4 && t.length > stub.length && t.startsWith(stub)) shared += nameIdf(stub);
        }
        if (shared === 0) continue;
        nameFit = Math.max(nameFit, shared / (probeWeight + nameWeight - shared));
      }
    }

    /* ---- 4. Combine. Address decides; the name adds at most a little. When
             there is no address evidence at all, a name-only match is capped
             below the confidence threshold — that cap is what stops a bare
             mail-domain token picking the shortest account in the file. ---- */
    let score: number;
    if (addrScore > 0) {
      score = Math.min(1, addrScore + nameFit * 0.15);
      if (nameFit > 0.2) why += " + name";
    } else {
      score = Math.min(0.55, nameFit * 0.7);
      why = nameFit > 0 ? "name only, no address match" : "";
    }

    if (score > 0) scored.push({ code, name, score, why });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 3);
  const best = scored[0];
  const runnerUp = scored[1];

  // Below the floor, say nothing. A wrong debtor reads as resolved, poisons the
  // debtor+PO duplicate key, and sends the agent to the wrong Arrow account.
  if (!best || best.score < 0.5) {
    return { code: null, name: null, confidence: "low", candidates };
  }

  // Two accounts scoring the same is not an answer either — usually two
  // branches at one site, or the same address on file twice.
  const decisive = !runnerUp || best.score - runnerUp.score >= 0.1;

  return {
    code: best.code,
    name: best.name,
    confidence: best.score >= 0.75 && decisive ? "high" : "low",
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
    [extracted.deliverTo, extracted.branchRef, extracted.contact, body.subject]
      .filter(Boolean)
      .join(" ") || null,
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
