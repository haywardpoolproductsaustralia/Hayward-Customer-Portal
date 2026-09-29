import type { PortalOrder } from "@/lib/portal-orders";

/**
 * Arrow sales-order import CSV.
 *
 * Mirrors "SalesOrders - export to excel - template.xlsx" exactly: ONE ROW PER
 * ORDER LINE, with the order header repeated on every row. Arrow groups rows
 * into an order by CUSTOMER CODE + CUSTOMER ORDER NUMBER.
 *
 * Column names and order are copied verbatim from the template, INCLUDING the
 * "COPNTACT NAME" typo and DELIVERY ADDRESS 4 sitting after STOCK LOCATION.
 * Arrow's importer may match on header text, so do not "fix" either.
 */
export const ARROW_CSV_COLUMNS = [
  "ORDER DATE",
  "CUSTOMER CODE",
  "CUSTOMER ORDER NUMBER",
  "DELIVERY DATE",
  "DELIVERY CUSTOMER NAME",
  "DELIVERY ADDRESS 1",
  "DELIVERY ADDRESS 2",
  "DELIVERY ADDRESS 3",
  "STOCK CODE",
  "QUANTITY",
  "BUY PRICE",
  "STOCK LOCATION",
  "DELIVERY ADDRESS 4",
  "COPNTACT NAME",
  "STOCK DESCRIPTION",
  "ORDER DESC1",
  "ORDER DESC2",
  "ORDER DESC3",
  "BLOCK TEXT",
] as const;

/**
 * -99999.99 is what every line in Arrow's template carries: Arrow's "no price
 * supplied - price it from the customer's price type" sentinel. Arrow's own
 * pricing is what gets invoiced, so letting Arrow price the line is the safe
 * default.
 *
 * Set to true to send the portal's server-recomputed unit price instead
 * (forces the price the customer saw onto the order).
 */
export const SEND_PORTAL_PRICE = false;
const ARROW_PRICE_SENTINEL = "-99999.99";

// Arrow column widths (CLEVAQUIP SORMAST), same limits enforced at submit.
const W = { address: 30, contact: 30, desc: 50, po: 15, sku: 15 } as const;

/**
 * Arrow char() columns: plain ASCII, upper case (as in the template), and no
 * commas, quotes or line breaks - so no field ever needs CSV quoting, which
 * sidesteps any doubt about how Arrow's parser handles quoted fields.
 */
function clean(v: unknown, upper = true): string {
  const s = String(v ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "") // drop accents, emoji, smart quotes, newlines
    .replace(/[",]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return upper ? s.toUpperCase() : s;
}

/** Word-wrap into lines of at most `width`, hard-splitting any word longer than that. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of text.split(" ").filter(Boolean)) {
    while (word.length > width) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Split the portal's one-line delivery address into Arrow's 4 x 30 lines.
 *
 * The portal prefills it as "street, suburb, city, state, postcode", so the
 * natural split is on commas - giving the template's shape:
 *   21 DIVIDEND STREET | MANSFIELD | QLD 4122
 * A bare postcode is joined onto the part before it ("QLD 4122"), and a
 * repeated part (Arrow often has suburb == city) is dropped. If the parts
 * can't be made to fit in 4 lines, fall back to plain word-wrapping.
 */
export function toAddressLines(deliverTo: string | null): [string, string, string, string] {
  const raw = String(deliverTo ?? "")
    .split(/[,\n]+/)
    .map((p) => clean(p))
    .filter(Boolean);

  const parts: string[] = [];
  for (const p of raw) {
    const prev = parts[parts.length - 1];
    if (prev && /^\d{4}$/.test(p)) parts[parts.length - 1] = `${prev} ${p}`;
    else if (prev !== p) parts.push(p);
  }

  let lines = parts;
  // Too many parts: merge the shortest adjacent pair that still fits.
  while (lines.length > 4) {
    let best = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const len = lines[i].length + 1 + lines[i + 1].length;
      if (len <= W.address && (best < 0 || len < lines[best].length + 1 + lines[best + 1].length)) best = i;
    }
    if (best < 0) break;
    lines = [...lines.slice(0, best), `${lines[best]} ${lines[best + 1]}`, ...lines.slice(best + 2)];
  }

  if (lines.length > 4 || lines.some((l) => l.length > W.address)) {
    lines = wrap(parts.join(" "), W.address);
  }

  const [a = "", b = "", c = "", d = ""] = lines.slice(0, 4);
  return [a, b, c, d];
}

/** DD/MM/YYYY in Melbourne time - how AU-locale Excel writes the template's dates to CSV. */
function arrowDate(input: number | string): string {
  const d = typeof input === "number" ? new Date(input) : new Date(`${input}T00:00:00+10:00`);
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

/** Rows for one order, as ordered arrays matching ARROW_CSV_COLUMNS. */
export function orderToRows(o: PortalOrder): string[][] {
  const orderDate = arrowDate(o.submittedAt);
  // Arrow needs a delivery date; with no required-by date, use the order date.
  const deliveryDate = o.requiredBy ? arrowDate(o.requiredBy) : orderDate;
  const [addr1, addr2, addr3, addr4] = toAddressLines(o.deliverTo);

  // DESC1 carries the portal reference (so an Arrow order can be traced back
  // to its WEB- ref) and the site phone, which has no column of its own.
  // Customer notes follow in DESC2-3; notes longer than those 100 characters
  // go in full into BLOCK TEXT so nothing the customer wrote is lost.
  const notes = clean(o.notes);
  const noteLines = wrap(notes, W.desc);
  const desc1 = clean([o.ref, o.phone ? `PH ${o.phone}` : ""].filter(Boolean).join(" ")).slice(0, W.desc);
  const blockText = noteLines.length > 2 ? notes : "";

  return o.lines.map((l) => {
    const price =
      SEND_PORTAL_PRICE && l.unitPriceServer != null ? l.unitPriceServer.toFixed(2) : ARROW_PRICE_SENTINEL;
    const row: Record<(typeof ARROW_CSV_COLUMNS)[number], string> = {
      "ORDER DATE": orderDate,
      "CUSTOMER CODE": clean(o.debtorCode),
      // PO is kept in the customer's own case: it is their reference, and the
      // Arrow matcher compares case-insensitively anyway.
      "CUSTOMER ORDER NUMBER": clean(o.poRef, false).slice(0, W.po),
      "DELIVERY DATE": deliveryDate,
      "DELIVERY CUSTOMER NAME": "",
      "DELIVERY ADDRESS 1": addr1,
      "DELIVERY ADDRESS 2": addr2,
      "DELIVERY ADDRESS 3": addr3,
      "STOCK CODE": clean(l.sku).slice(0, W.sku),
      QUANTITY: String(l.qty),
      "BUY PRICE": price,
      "STOCK LOCATION": "",
      "DELIVERY ADDRESS 4": addr4,
      "COPNTACT NAME": clean(o.contact).slice(0, W.contact),
      "STOCK DESCRIPTION": "",
      "ORDER DESC1": desc1,
      "ORDER DESC2": noteLines[0] ?? "",
      "ORDER DESC3": noteLines[1] ?? "",
      "BLOCK TEXT": blockText,
    };
    return ARROW_CSV_COLUMNS.map((c) => row[c]);
  });
}

/** The whole file: header row + every line of every order, CRLF line endings. */
export function buildArrowCsv(orders: PortalOrder[]): string {
  const rows = [Array.from(ARROW_CSV_COLUMNS), ...orders.flatMap(orderToRows)];
  return rows.map((r) => r.join(",")).join("\r\n") + "\r\n";
}
