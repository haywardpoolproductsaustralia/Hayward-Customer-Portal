// Shared customer search, used by the Customer Lookup page and the header
// CustomerPicker so both behave identically.
//
// WHY THIS ISN'T JUST .includes()
//
// Two things break a plain substring search against Arrow's customer file:
//
//   1. DRSMAST.CUSTOMER_NAME is char(30) and Arrow truncates to fit. The real
//      "REECE IRRIGATION & POOLS DANDENONG" is 34 characters, so what's stored
//      is "REECE IRRIGATION & POOLS DANDE". Searching "dandenong" finds
//      nothing, because the branch word was cut off in the database. The only
//      string that matched was "dande", which nobody would think to type.
//
//   2. Even without truncation, the words a person types aren't adjacent in
//      the stored value. "reece dan" fails against "REECE IRRIGATION & POOLS
//      DANDE" because a substring match needs those characters consecutive.
//
// So: split the query into words and require EVERY word to match some word in
// the record, comparing as prefixes in BOTH directions. "dandenong" matches the
// stored stub "dande" (query extends the stored word) and "dan" matches it too
// (query is a prefix of it). That covers truncation and abbreviation at once
// without loosening the search into fuzzy nonsense.

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * True when every word in `query` matches some word in `fields`.
 *
 * A query word matches a record word when either is a prefix of the other.
 * The record-is-shorter direction is capped at 4 characters so a two-letter
 * fragment can't match everything — that's the case that only exists because
 * of the char(30) truncation, and 4 is long enough to be meaningful.
 */
export function matchesCustomerQuery(fields: (string | null | undefined)[], query: string): boolean {
  const q = norm(query);
  if (!q) return false;

  const words = norm(fields.filter(Boolean).join(' ')).split(' ').filter(Boolean);
  if (!words.length) return false;

  return q.split(' ').filter(Boolean).every((term) =>
    words.some((w) => w.startsWith(term) || (w.length >= 4 && term.startsWith(w)))
  );
}

/**
 * Digits only, with the AU country code and trunk zero removed, so a caller-ID
 * "+61 3 9793 1234" compares equal to a stored "03 9793 1234".
 */
export function normalizePhone(s?: string | null): string {
  let d = (s ?? '').replace(/\D/g, '');
  if (d.startsWith('0061')) d = d.slice(4);
  else if (d.startsWith('61')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}
