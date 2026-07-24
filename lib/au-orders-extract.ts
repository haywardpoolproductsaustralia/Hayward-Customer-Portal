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

/* ---------------------------------------------------------------------------
   The sender address. Two independent signals, and we were using neither.

     minchinbury.irrigation.nsw@reece.com.au
     ^^^^^^^^^^^ branch                ^^^^^ organisation

   The LOCAL PART frequently names the branch outright — every Reece branch
   mailbox is <locality>.irrigation.<state>@. That is often the only place the
   branch is named in a machine-readable form, because Arrow holds the group's
   billing address for chain accounts rather than the branch's own.

   The DOMAIN names the company. Used as a gate rather than as a name probe:
   an order from reece.com.au is a Reece order, so a candidate that isn't a
   Reece account is very probably wrong however well its address matches.
   That is the case here — SWIMART MINCHENBURY sits at the same suburb and
   postcode as the delivery block and won on address alone.
   --------------------------------------------------------------------------- */

// Public mailbox providers and generic mail hostnames. These identify a mail
// service, not a customer, so they must never gate anything.
const GENERIC_EMAIL_DOMAINS = new Set([
  "GMAIL", "HOTMAIL", "OUTLOOK", "YAHOO", "BIGPOND", "LIVE", "ICLOUD", "MSN",
  "AOL", "OPTUSNET", "OPTUS", "IINET", "TPG", "INTERNODE", "WESTNET", "DODO",
  "PROTONMAIL", "GMX", "ME", "MAC", "MAIL", "EMAIL", "WEBMAIL", "SMTP", "MX",
  "EXCHANGE", "OUTBOUND", "SERVER", "HAYWARD",
]);

// Words that appear in a mailbox name without identifying anything: role
// mailboxes, states, and the department words chains put in branch addresses.
const EMAIL_LOCAL_STOP = new Set([
  "SALES", "ORDERS", "ORDER", "INFO", "ADMIN", "ACCOUNTS", "ACCOUNT", "NOREPLY",
  "NO", "REPLY", "DONOTREPLY", "PURCHASING", "PURCHASE", "SERVICE", "SUPPORT",
  "ENQUIRIES", "ENQUIRY", "CONTACT", "OFFICE", "BRANCH", "STORE", "SHOP",
  "IRRIGATION", "PLUMBING", "POOLS", "POOL", "SPA", "HVAC", "TRADE", "STOCK",
  "INVOICES", "INVOICE", "NSW", "VIC", "QLD", "WA", "SA", "NT", "TAS", "ACT",
  "AU", "AUS", "AUST", "AUSTRALIA", "NZ", "COM", "NET", "ORG", "CO",
]);

/** Split a mailbox local part into words. Handles the dotted, underscored and
 *  camelCase forms all in use — "SouthPenrith.Irrigation.NSW" yields
 *  SOUTH, PENRITH. */
function emailLocalTokens(fromEmail: string): string[] {
  const local = (fromEmail.split("@")[0] ?? "");
  if (!local) return [];
  return norm(local.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .split(" ")
    .filter((w) => w.length > 2 && !EMAIL_LOCAL_STOP.has(w) && !/^\d+$/.test(w));
}

/** The organisation-identifying labels of the sender's domain. */
function emailDomainTokens(fromEmail: string): string[] {
  const domain = (fromEmail.split("@")[1] ?? "");
  if (!domain) return [];
  return norm(domain.replace(/\./g, " "))
    .split(" ")
    .filter((w) => w.length > 2 && !GENERIC_EMAIL_DOMAINS.has(w) && !EMAIL_LOCAL_STOP.has(w));
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
  /** How many accounts share each suburb+postcode. Chains are billed to head
   *  office, so all 137 Reece accounts carry the same Burwood 3125 address —
   *  matching on it cannot tell one branch from another. Address evidence is
   *  scaled by how much it actually narrows the field. */
  addressOwners: Map<string, number>;
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
  const addressOwners = new Map<string, number>();
  for (const e of entries) {
    for (const k of e.facts.phones) phoneOwners.set(k, (phoneOwners.get(k) ?? 0) + 1);
    const p = customerProfiles[e.code];
    const sig = norm([p?.suburb ?? p?.city ?? "", p?.postcode ?? ""].join(" "));
    if (sig) addressOwners.set(sig, (addressOwners.get(sig) ?? 0) + 1);
  }

  const index: CustomerIndex = {
    entries,
    phoneOwners,
    addressOwners,
    // IDF over locality/street words across the whole customer file, so common
    // words (INDUSTRIAL, CENTRAL, a suburb shared by many accounts) can't carry
    // a match while a distinctive one can.
    addrIdf: buildIdf(entries.map((e) => [...e.facts.words])),
    nameIdf: buildIdf(entries.map((e) => e.nameToks)),
  };
  indexCache = { key, index };
  return index;
}

/** Locality words from the order: the delivery block and mailbox name, with
 *  street types, states and TRADE/department words removed. What is left is the
 *  suburb, plus the odd street name that harmlessly matches nothing. Stripping
 *  the trade words is what makes the join below work — "Irrigation" and "Pools"
 *  appear in both the delivery block and two Arrow account names, and left in
 *  they match the wrong branch. */
function localityTokens(orderAddressText: string | null, localTokens: string[]): string[] {
  const fromAddress = norm(orderAddressText ?? "")
    .split(" ")
    .filter(
      (w) =>
        w.length > 2 && !ADDRESS_STOP.has(w) && !EMAIL_LOCAL_STOP.has(w) && !/^\d+$/.test(w)
    );
  return [...new Set([...fromAddress, ...localTokens.filter((t) => !EMAIL_LOCAL_STOP.has(t))])];
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
  const { entries, addrIdf, nameIdf, phoneOwners, addressOwners } =
    buildCustomerIndex(customerNames, customerProfiles);

  // Weight a token appearing exactly once in the file would carry. Used to
  // judge how distinctive a name match is, independent of file size.
  const uniqueTokenIdf = Math.log(entries.length + 1) + 0.1;

  const localTokens = emailLocalTokens(fromEmail);
  const domainTokens = emailDomainTokens(fromEmail);

  // The mailbox name is a name probe in its own right — for a chain branch it
  // is often the only machine-readable statement of WHICH branch this is.
  // The domain is deliberately NOT a name probe: as one word it used to score
  // 0.50 against the shortest matching account and pick the wrong branch. It
  // gates instead, below.
  /* Name probes, WEIGHTED by how order-specific each one is.

     The delivery block is a name probe as well as an address one: on a chain PO
     it opens with the ship-to branch — "Irrigation & Pools Minchinbury (2104),
     10 Grex Avenue, Minchinbury NSW 2770" — and for a chain that is the one
     place in the document that names the branch. Feeding it only into address
     matching compared it against REECE MINCHINBURY's registered address, which
     is head office in Burwood, so the branch name was never looked at.

     The sender display name gets the LOWEST weight, and that is the important
     part. "Reece Irrigation & Pools" is a property of the mailbox — identical on
     every Reece order from every branch — so it can identify the company but
     never the branch. Unweighted it beat order-specific evidence, because
     IRRIGATION and POOLS happen to be rare in Arrow (only Coffs 210164 and
     Campsie 210161 carry them) and IDF therefore rated them highly. IDF over the
     customer file is the wrong prior for a word that is generic on the order
     side; the weighting corrects for that. */
  const probeTokenSets = [
    { text: orderAddressText, weight: 1.0 },  // per-order, names the ship-to branch
    { text: companyGuess, weight: 0.85 },     // extracted, but often the group letterhead
    { text: fromName, weight: 0.7 },          // per-mailbox, constant across branches
  ]
    .filter((p) => p.text)
    .map((p) => ({ toks: [...new Set(nameTokens(p.text as string))], weight: p.weight }))
    .filter((p) => p.toks.length > 0);

  // How many accounts the sender's domain points at. A domain that matches
  // nothing in the customer file (a third-party system such as an order-
  // management SaaS) tells us nothing and must not gate. A domain matching
  // almost everything isn't discriminating either.
  const domainOwners = new Map<string, number>();
  for (const t of domainTokens) {
    let n = 0;
    for (const e of entries) if (e.nameToks.includes(t)) n++;
    if (n > 0 && n < entries.length * 0.4) domainOwners.set(t, n);
  }
  const domainIdentifiesOrg = domainOwners.size > 0;

  /* ---- DETERMINISTIC JOIN: sender domain x suburb ------------------------

     The domain says which company; the suburb says which branch. Where exactly
     one account's name carries both, that IS the account and no scoring is
     needed — reece.com.au + MINCHINBURY has one answer in the whole file.

     Runs first because it is exact where the scorer is probabilistic, and it is
     the shape the data actually has: chain branches are named "<COMPANY>
     <LOCALITY>" in Arrow. It only claims a result when the answer is UNIQUE —
     two matches (POOLWERX BATHURST and POOLWERX BATHURST (THORNBERRY)) means the
     join cannot separate them either, so it stands down and lets the scorer rank
     them with candidates shown.

     Two passes, MAILBOX FIRST. The mailbox names the branch that PLACED the
     order; the delivery block names where it ships, which is usually the same
     branch but not always — a drop-ship to a job site would otherwise join to
     whichever branch happens to share that suburb.

     Truncated names are handled: a name at Arrow's char(30) cap has its final
     token prefix-matched, so REECE IRRIGATION & POOLS CAMPB still joins to
     CAMPBELLTOWN. */
  if (domainIdentifiesOrg) {
    const joinOn = (localities: string[]) =>
      entries.filter((e) => {
        if (customerProfiles[e.code]?.deleted) return false;
        if (!domainTokens.some((t) => domainOwners.has(t) && e.nameToks.includes(t))) return false;
        return localities.some(
          (t) =>
            e.nameToks.includes(t) ||
            (e.stub !== null && e.stub.length >= 4 && t.length > e.stub.length && t.startsWith(e.stub))
        );
      });

    const passes: [string[], string][] = [
      [localTokens.filter((t) => !EMAIL_LOCAL_STOP.has(t)), "sender domain + mailbox suburb"],
      [localityTokens(orderAddressText, []), "sender domain + delivery suburb"],
    ];

    for (const [localities, why] of passes) {
      if (localities.length === 0) continue;
      const joined = joinOn(localities);
      if (joined.length !== 1) continue;
      const hit = joined[0];
      return {
        code: hit.code,
        name: hit.name,
        confidence: "high",
        candidates: [{ code: hit.code, name: hit.name, score: 1, why }],
      };
    }
  }

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
      for (const { toks: pToks, weight: probeWeightFactor } of probeTokenSets) {
        let shared = 0;
        let bestSharedIdf = 0;
        for (const t of pToks) {
          let hit = 0;
          if (nameToks.includes(t)) hit = nameIdf(t);
          else if (stub && stub.length >= 4 && t.length > stub.length && t.startsWith(stub)) hit = nameIdf(stub);
          if (hit > 0) { shared += hit; bestSharedIdf = Math.max(bestSharedIdf, hit); }
        }
        if (shared === 0) continue;

        // COVERAGE, not symmetric overlap: how much of the ARROW name the
        // order accounts for. Arrow's CUSTOMER_NAME is a short, often
        // truncated subset of the real trading name — "REECE CAMPBELLTOWN" for
        // "Reece Irrigation & Pools Campbelltown" — so words present on the
        // order but absent from Arrow are expected and must not be penalised.
        const coverage = shared / nameWeight;

        // But coverage alone would let a very short generic name win outright
        // (an account called just "REECE" would be 100% covered by any Reece
        // order — the exact trap that started this). So require the match to
        // rest on something genuinely rare: scale by the strongest shared
        // token's weight against the weight of a token unique in the file.
        const distinctiveness = Math.min(1, bestSharedIdf / uniqueTokenIdf);

        nameFit = Math.max(nameFit, coverage * distinctiveness * probeWeightFactor);
      }
    }

    /* ---- 3b. Mailbox name as a BRANCH identifier.

       Scored separately rather than as another name probe, because the name
       score rewards covering a lot of the account name and that is the wrong
       shape here. The sender display name "Reece Irrigation & Pools" covers
       three of the four words in "REECE IRRIGATION & POOLS COFFS", so Coffs
       out-scored every other branch on every Reece order — IRRIGATION and
       POOLS are rare in Arrow (two accounts carry them) so IDF rates them
       highly, even though they are generic in the sender's own name.

       A single distinctive token shared between the mailbox name and the
       account name is the stronger and cleaner signal: minchinbury.irrigation
       .nsw@ against REECE MINCHINBURY. Weighted purely by how rare that token
       is, so a mailbox called sales@ or a common word carries nothing. ----- */
    let mailboxFit = 0;
    for (const t of localTokens) {
      if (!nameToks.includes(t)) continue;
      mailboxFit = Math.max(mailboxFit, Math.min(1, nameIdf(t) / uniqueTokenIdf));
    }

    /* ---- 4. Combine.

       Address evidence is worth only as much as it narrows the field. Arrow
       bills chain branches to head office, so every Reece account carries the
       same Burwood 3125 address — an address hit there identifies 137 accounts,
       which is to say none of them. Scale the address score by how many
       accounts share that address, and let the name decide when the address
       cannot.

       Letting the name decide is safe because nameFit is IDF-weighted: a bare
       "REECE" is common across the file and scores near nothing, while
       "REECE CAMPBELLTOWN" shares a rare token and scores high. That is what
       makes this different from the original name-first matcher, which counted
       every word equally and handed everything to the shortest account. ----- */
    const prof2 = customerProfiles[code];
    const addrSig = norm([prof2?.suburb ?? prof2?.city ?? "", prof2?.postcode ?? ""].join(" "));
    const sharedBy = addrSig ? addressOwners.get(addrSig) ?? 1 : 1;
    // 1 account -> full weight; 4 -> half; 137 -> ~8%.
    const addrPower = 1 / Math.sqrt(sharedBy);

    // A unique phone is a direct identifier, not a locality, so it is exempt.
    const effectiveAddr = why.startsWith("unique phone") ? addrScore : addrScore * addrPower;

    if (sharedBy > 3 && addrScore > 0 && !why.startsWith("unique phone")) {
      why += ` (address shared by ${sharedBy})`;
    }

    // Whichever evidence is strongest leads; the others corroborate.
    const signals = [effectiveAddr, nameFit, mailboxFit];
    const strong = Math.max(...signals);
    const rest = signals.reduce((a, b) => a + b, 0) - strong;
    let score = Math.min(1, strong + rest * 0.15);
    if (strong === mailboxFit && mailboxFit > 0.2) {
      why = why ? `mailbox name + ${why}` : "mailbox name";
    } else if (mailboxFit > 0.2) {
      why += " + mailbox name";
    } else if (nameFit > effectiveAddr && nameFit > 0.2) {
      why = why ? `name + ${why}` : "name match";
    } else if (nameFit > 0.2 && effectiveAddr > 0) {
      why += " + name";
    }

    /* ---- 5. Sender domain, as an organisation gate.

       Applied only when the domain actually names accounts in the customer
       file — a third-party sender (an order-management SaaS, a freight desk)
       matches nothing and must leave the score alone rather than penalise
       every candidate equally.

       Where it does apply, it is decisive about the COMPANY and silent about
       the branch: an order from reece.com.au belongs to a Reece account, so a
       same-suburb account belonging to someone else is wrong however well its
       address matches. That is exactly the SWIMART MINCHENBURY case — Arrow
       holds Swimart's real Minchinbury address and Reece's Burwood billing
       address, so address evidence favoured the wrong company outright.

       A penalty rather than a hard exclusion, because a customer can legit-
       imately order from a parent or agent's domain. ---------------------- */
    if (domainIdentifiesOrg) {
      const onDomain = domainTokens.some((t) => domainOwners.has(t) && nameToks.includes(t));
      if (onDomain) {
        score = Math.min(1, score + 0.2);
        why = why ? `${why} + sender domain` : "sender domain";
      } else {
        score *= 0.45;
        why = why ? `${why} (not a ${[...domainOwners.keys()][0]} account)` : "";
      }
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

/* ---------------------------------------------------------------------------
   Re-resolving records that are already in the queue.

   The debtor is decided once, at ingest. When the matcher improves, everything
   already queued keeps whatever the old version decided — so a fix ships and
   the wrong codes stay on screen. This re-runs ONLY the customer match, from
   the fields already stored on the record, and never calls the extraction
   model: SKUs, quantities and prices are left exactly as they are.

   companyGuess and branchRef are extraction outputs that were never persisted,
   so they are unavailable here. That costs less than it sounds: companyGuess is
   typically the group letterhead ("Reece Australia Pty Ltd"), which is what was
   pulling matches to the wrong branch in the first place. The delivery block,
   contact and sender address — the signals that actually decide it — are all
   stored.
   --------------------------------------------------------------------------- */
export interface ReResolveInput {
  fromEmail: string;
  fromName: string | null;
  deliverTo: string | null;
  contact: string | null;
}

export function reResolveCustomer(
  rec: ReResolveInput,
  customerNames: Record<string, string>,
  customerProfiles: Record<string, AddressProfile>
) {
  return resolveCustomer(
    null, // companyGuess not persisted — see above
    rec.fromName ?? null,
    rec.fromEmail,
    [rec.deliverTo, rec.contact].filter(Boolean).join(" ") || null,
    customerNames,
    customerProfiles
  );
}

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
