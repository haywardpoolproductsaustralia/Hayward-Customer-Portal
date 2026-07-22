import { redis } from "@/lib/redis";

/**
 * portal-orders — sales orders raised by CUSTOMERS directly on the portal
 * (quote builder → "Convert to order").
 *
 * Deliberately a SEPARATE queue from the emailed-order intake (`soq:*`) and
 * from the read-only sales-order history (`orders:*`). Everything here lives
 * under `pso:` so the three can never collide.
 *
 * Why this data is different from `soq:`, and why that matters to whoever
 * works the queue:
 *   - the debtor code is taken from the submitter's Clerk org access, not
 *     guessed by a name matcher, so it is authoritative;
 *   - every SKU was chosen from the live Arrow stock list, so there are no
 *     unmatched lines and no suggestion-picking;
 *   - prices are recomputed server-side at submit time, so what's stored is
 *     never whatever the browser happened to send.
 * The staff job is therefore only ever "key this into Arrow", never
 * "work out what this order actually says".
 *
 * The claim/lock that stops two staff keying the same order is enforced by the
 * Lua scripts below; Lua runs atomically inside Redis, so a "check then take"
 * sequence can't be interleaved by a second person. Same semantics as
 * lib/au-orders-inbox.ts on purpose — if you ever merge the two queues, the
 * state machine already matches.
 */

export const CLAIM_TTL_MS = 20 * 60 * 1000; // 20 minutes

export type PortalOrderStatus = "new" | "claimed" | "keyed" | "cancelled";

export interface PortalOrderLine {
  sku: string;
  description: string | null;
  qty: number;
  listPrice: number | null;
  /** What the customer was shown in the quote builder when they submitted. */
  unitPriceQuoted: number | null;
  /** What the server independently recomputed at submit time. Authoritative. */
  unitPriceServer: number | null;
  /** True when the two disagree by more than a cent — agent must eyeball it. */
  priceMismatch: boolean;
  lineTotal: number | null;
  /** Free stock across all locations at the moment of submission, informational. */
  onHandAtSubmit: number | null;
}

/** Immutable payload written once at submit. Stored as JSON in the `data` field. */
export interface PortalOrderData {
  /** Human-facing reference shown to the customer, e.g. "WEB-000123". */
  ref: string;
  submittedAt: number;

  // who submitted
  orgId: string;
  orgName: string;
  submittedByUserId: string;
  submittedByName: string;
  submittedByEmail: string | null;

  // which account it's for (authoritative — from Clerk org access, not guessed)
  debtorCode: string;
  debtorName: string | null;

  // order header
  poRef: string;
  requiredBy: string | null;
  deliverTo: string | null;
  contact: string | null;
  phone: string | null;
  notes: string | null;

  // body
  lines: PortalOrderLine[];
  priceType: string | null;
  subTotal: number | null;

  /** Set when this debtor+poRef combination was already submitted. */
  duplicateOf: string | null;
}

export interface PortalOrder extends PortalOrderData {
  id: string;
  status: PortalOrderStatus;
  claimedBy: string | null;
  claimedByName: string | null;
  claimAt: number | null;
  claimExpiresAt: number | null;
  keyedBy: string | null;
  keyedByName: string | null;
  keyedAt: number | null;
  /** Free-text reason captured when staff cancel/reject an order. */
  cancelReason: string | null;

  // Set by portal-sync on AZ-Grey when a matching sales order appears in Arrow.
  // Field names match lib/au-orders-inbox.ts exactly so the existing matcher
  // can be pointed at this keyspace without rewriting it.
  seenInArrow: boolean;
  seenInArrowAt: number | null;
  arrowOrderNo: string | null;
  arrowEnteredBy: string | null;
  arrowTotalQty: number | null;
}

const itemKey = (id: string) => `pso:${id}`;
const INDEX = "pso:index"; // sorted set: score=submittedAt, member=id
const custKey = (code: string) => `pso:cust:${code}`; // per-debtor index for "my orders"
const dupeKey = (debtor: string, ref: string) => `pso:dupe:${debtor}:${ref}`;
const SEQ = "pso:seq";

/** Customer-facing progress, derived so the wording lives in exactly one place. */
export function customerStatus(o: PortalOrder): { label: string; detail: string | null } {
  if (o.status === "cancelled") {
    return { label: "Cancelled", detail: o.cancelReason };
  }
  if (o.seenInArrow && o.arrowOrderNo) {
    return { label: "Accepted", detail: `Hayward order ${o.arrowOrderNo}` };
  }
  if (o.status === "keyed") return { label: "Accepted", detail: "Entered into our system" };
  if (o.status === "claimed") return { label: "Being processed", detail: null };
  return { label: "Received", detail: null };
}

function rowToRecord(id: string, h: Record<string, unknown>): PortalOrder {
  const data = (typeof h.data === "string" ? JSON.parse(h.data) : h.data) as PortalOrderData;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    id,
    ...data,
    status: (h.status as PortalOrderStatus) ?? "new",
    claimedBy: (h.claimedBy as string) || null,
    claimedByName: (h.claimedByName as string) || null,
    claimAt: num(h.claimAt),
    claimExpiresAt: num(h.claimExpiresAt),
    keyedBy: (h.keyedBy as string) || null,
    keyedByName: (h.keyedByName as string) || null,
    keyedAt: num(h.keyedAt),
    cancelReason: (h.cancelReason as string) || null,
    seenInArrow: h.seenInArrow === "1" || h.seenInArrow === 1,
    seenInArrowAt: num(h.seenInArrowAt),
    arrowOrderNo: (h.arrowOrderNo as string) || null,
    arrowEnteredBy: (h.arrowEnteredBy as string) || null,
    arrowTotalQty: num(h.arrowTotalQty),
  };
}

/** Expired claims read as unclaimed rather than being stuck to whoever walked away. */
function relaxExpiredClaim(rec: PortalOrder, now: number): PortalOrder {
  if (rec.status === "claimed" && rec.claimExpiresAt && rec.claimExpiresAt < now) {
    return { ...rec, status: "new", claimedBy: null, claimedByName: null };
  }
  return rec;
}

async function hydrate(ids: string[]): Promise<PortalOrder[]> {
  if (ids.length === 0) return [];
  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.hgetall(itemKey(id)));
  const rows = (await pipe.exec()) as Array<Record<string, unknown> | null>;
  const now = Date.now();
  const out: PortalOrder[] = [];
  ids.forEach((id, i) => {
    const row = rows[i];
    if (!row || Object.keys(row).length === 0) return;
    out.push(relaxExpiredClaim(rowToRecord(id, row), now));
  });
  return out;
}

/** Staff view: newest first. Hides keyed/cancelled unless asked. */
export async function listPortalOrders(opts: { includeClosed?: boolean } = {}): Promise<PortalOrder[]> {
  const ids = await redis.zrange<string[]>(INDEX, 0, -1, { rev: true });
  const all = await hydrate(ids);
  if (opts.includeClosed) return all;
  return all.filter((o) => o.status !== "keyed" && o.status !== "cancelled");
}

/** Customer view: their own orders across every account code they can see. */
export async function listOrdersForCustomer(codes: string[], limit = 25): Promise<PortalOrder[]> {
  if (codes.length === 0) return [];
  // Cap the fan-out: an aggregate login can hold hundreds of codes and we only
  // ever render the most recent handful.
  const pipe = redis.pipeline();
  codes.forEach((c) => pipe.zrange(custKey(c), 0, limit - 1, { rev: true }));
  const lists = (await pipe.exec()) as Array<string[] | null>;
  const ids = Array.from(new Set(lists.flatMap((l) => l ?? [])));
  const records = await hydrate(ids);
  return records.sort((a, b) => b.submittedAt - a.submittedAt).slice(0, limit);
}

export async function getPortalOrder(id: string): Promise<PortalOrder | null> {
  const h = await redis.hgetall(itemKey(id));
  if (!h || Object.keys(h).length === 0) return null;
  return relaxExpiredClaim(rowToRecord(id, h), Date.now());
}

/** Returns the id of an earlier order with the same debtor + customer PO, if any. */
export async function findDuplicate(debtorCode: string, poRef: string): Promise<string | null> {
  if (!debtorCode || !poRef) return null;
  return await redis.get<string>(dupeKey(debtorCode, poRef));
}

/** Next human-facing reference. Sequential so staff can read it over the phone. */
export async function nextRef(): Promise<string> {
  const n = await redis.incr(SEQ);
  return `WEB-${String(n).padStart(6, "0")}`;
}

export async function createPortalOrder(data: PortalOrderData): Promise<string> {
  const id = crypto.randomUUID();

  await redis.hset(itemKey(id), {
    data: JSON.stringify(data),
    status: "new",
    claimedBy: "",
    claimedByName: "",
    claimAt: "0",
    claimExpiresAt: "0",
    keyedBy: "",
    keyedByName: "",
    keyedAt: "0",
    cancelReason: "",
    seenInArrow: "0",
    seenInArrowAt: "0",
    arrowOrderNo: "",
    arrowEnteredBy: "",
    arrowTotalQty: "",
  });
  await redis.zadd(INDEX, { score: data.submittedAt, member: id });
  await redis.zadd(custKey(data.debtorCode), { score: data.submittedAt, member: id });
  // nx: the FIRST order to use a debtor+PO owns the key, so a later resubmit is
  // flagged as the duplicate rather than overwriting the original.
  await redis.set(dupeKey(data.debtorCode, data.poRef), id, { nx: true });
  return id;
}

// --- atomic claim / release / key / cancel / heartbeat --------------------

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "closed" | "not_owner" | "already_keyed" }
  | { ok: false; reason: "taken"; by: string };

const CLAIM_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then return 'NOT_FOUND' end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'keyed' or status == 'cancelled' then return 'CLOSED' end
local owner = redis.call('HGET', KEYS[1], 'claimedBy')
local expires = tonumber(redis.call('HGET', KEYS[1], 'claimExpiresAt')) or 0
local now = tonumber(ARGV[3])
if status == 'claimed' and owner and owner ~= '' and owner ~= ARGV[1] and expires > now then
  local name = redis.call('HGET', KEYS[1], 'claimedByName')
  return 'TAKEN:' .. (name or 'another agent')
end
redis.call('HSET', KEYS[1], 'status', 'claimed', 'claimedBy', ARGV[1], 'claimedByName', ARGV[2], 'claimAt', ARGV[3], 'claimExpiresAt', tostring(now + tonumber(ARGV[4])))
return 'OK'
`;

const RELEASE_LUA = `
local owner = redis.call('HGET', KEYS[1], 'claimedBy')
if owner ~= ARGV[1] then return 'NOT_OWNER' end
redis.call('HSET', KEYS[1], 'status', 'new', 'claimedBy', '', 'claimedByName', '', 'claimAt', '0', 'claimExpiresAt', '0')
return 'OK'
`;

const KEY_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'keyed' then return 'ALREADY_KEYED' end
local owner = redis.call('HGET', KEYS[1], 'claimedBy')
if owner ~= ARGV[1] then return 'NOT_OWNER' end
redis.call('HSET', KEYS[1], 'status', 'keyed', 'keyedBy', ARGV[1], 'keyedByName', ARGV[2], 'keyedAt', ARGV[3])
return 'OK'
`;

const CANCEL_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'keyed' then return 'ALREADY_KEYED' end
local owner = redis.call('HGET', KEYS[1], 'claimedBy')
if owner ~= ARGV[1] then return 'NOT_OWNER' end
redis.call('HSET', KEYS[1], 'status', 'cancelled', 'cancelReason', ARGV[2], 'keyedBy', ARGV[1], 'keyedByName', ARGV[3], 'keyedAt', ARGV[4])
return 'OK'
`;

const HEARTBEAT_LUA = `
local owner = redis.call('HGET', KEYS[1], 'claimedBy')
local status = redis.call('HGET', KEYS[1], 'status')
if owner ~= ARGV[1] or status ~= 'claimed' then return 'NOT_OWNER' end
local now = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'claimExpiresAt', tostring(now + tonumber(ARGV[3])))
return 'OK'
`;

function toOutcome(res: string): ClaimOutcome {
  if (res === "OK") return { ok: true };
  if (res === "NOT_FOUND") return { ok: false, reason: "not_found" };
  if (res === "CLOSED") return { ok: false, reason: "closed" };
  if (res === "ALREADY_KEYED") return { ok: false, reason: "already_keyed" };
  if (res && res.startsWith("TAKEN:")) return { ok: false, reason: "taken", by: res.slice(6) };
  return { ok: false, reason: "not_owner" };
}

export async function claimOrder(id: string, userId: string, userName: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(
    CLAIM_LUA,
    [itemKey(id)],
    [userId, userName, String(Date.now()), String(CLAIM_TTL_MS)]
  )) as string;
  return toOutcome(res);
}

export async function releaseOrder(id: string, userId: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(RELEASE_LUA, [itemKey(id)], [userId])) as string;
  return toOutcome(res);
}

export async function markKeyed(id: string, userId: string, userName: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(KEY_LUA, [itemKey(id)], [userId, userName, String(Date.now())])) as string;
  return toOutcome(res);
}

export async function cancelOrder(
  id: string,
  userId: string,
  userName: string,
  reason: string
): Promise<ClaimOutcome> {
  const res = (await redis.eval(
    CANCEL_LUA,
    [itemKey(id)],
    [userId, reason, userName, String(Date.now())]
  )) as string;
  return toOutcome(res);
}

export async function heartbeatOrder(id: string, userId: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(
    HEARTBEAT_LUA,
    [itemKey(id)],
    [userId, String(Date.now()), String(CLAIM_TTL_MS)]
  )) as string;
  return toOutcome(res);
}
