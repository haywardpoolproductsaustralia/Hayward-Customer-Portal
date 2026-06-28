import { Redis } from "@upstash/redis";

/**
 * Order intake queue — data model + Redis operations.
 *
 * Uses the SAME Upstash instance as the rest of the portal. All keys live under
 * the `order:` / `orders:` namespace so they don't collide with anything else.
 *
 * The claim/lock that stops two agents keying the same order is enforced by the
 * Lua scripts at the bottom of this file. Lua runs atomically inside Redis, so a
 * "check status, then take it" sequence can't be interleaved by a second agent.
 */

const redis = Redis.fromEnv();

// How long a claim is held before it auto-releases if the agent goes idle.
export const CLAIM_TTL_MS = 20 * 60 * 1000; // 20 minutes

// ---------------------------------------------------------------------------
// Types — this is also the contract the email-extraction pipeline writes to.
// ---------------------------------------------------------------------------

export type OrderStatus = "new" | "claimed" | "keyed";

export interface OrderLine {
  raw: string;            // the line exactly as the customer wrote it
  sku: string | null;     // matched STKMAST code, or null if unmatched
  description: string | null;
  qty: number | null;
  unit: string | null;
  claimedPrice: number | null;   // price the customer referenced, if any (cross-check only)
  confidence: "high" | "low";    // "low" => human must verify the SKU
}

/** Immutable payload produced by extraction. Stored as JSON in the `data` field. */
export interface OrderData {
  internetMessageId: string;     // dedupe key — one record per email, forever
  receivedAt: number;            // epoch ms
  emailWebUrl: string | null;    // Graph webLink back to the original email
  fromEmail: string;
  fromName: string | null;
  debtorCode: string | null;     // resolved DRSMAST code, null if unresolved
  debtorName: string | null;
  poRef: string | null;
  deliverBy: string | null;      // ISO date or free text
  deliverTo: string | null;
  contact: string | null;
  lines: OrderLine[];
  notes: string | null;
  extractionConfidence: "high" | "low";
  duplicateOf: string | null;    // id of an earlier order with same debtor+PO
}

/** Mutable claim/audit state lives in flat hash fields so Lua can touch it. */
export interface OrderRecord extends OrderData {
  id: string;
  status: OrderStatus;
  claimedBy: string | null;
  claimedByName: string | null;
  claimAt: number | null;
  claimExpiresAt: number | null;
  keyedBy: string | null;
  keyedByName: string | null;
  keyedAt: number | null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const orderKey = (id: string) => `order:${id}`;
const INDEX = "orders:byTime";                  // sorted set: score=receivedAt, member=id
const dupeKey = (debtor: string, po: string) => `orders:dupe:${debtor}:${po}`;
const msgKey = (msgId: string) => `orders:msg:${msgId}`; // internetMessageId -> id (dedupe)

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function rowToRecord(id: string, h: Record<string, unknown>): OrderRecord {
  // `data` is stored as a JSON string; @upstash parses it back to an object on read.
  const data = (typeof h.data === "string" ? JSON.parse(h.data) : h.data) as OrderData;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    id,
    ...data,
    status: (h.status as OrderStatus) ?? "new",
    claimedBy: (h.claimedBy as string) || null,
    claimedByName: (h.claimedByName as string) || null,
    claimAt: num(h.claimAt),
    claimExpiresAt: num(h.claimExpiresAt),
    keyedBy: (h.keyedBy as string) || null,
    keyedByName: (h.keyedByName as string) || null,
    keyedAt: num(h.keyedAt),
  };
}

/** List orders newest-first. By default hides orders already keyed into Arrow. */
export async function listOrders(opts: { includeKeyed?: boolean } = {}): Promise<OrderRecord[]> {
  const ids = await redis.zrange<string[]>(INDEX, 0, -1, { rev: true });
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.hgetall(orderKey(id)));
  const rows = (await pipe.exec()) as Array<Record<string, unknown> | null>;

  const now = Date.now();
  const out: OrderRecord[] = [];
  ids.forEach((id, i) => {
    const row = rows[i];
    if (!row) return;
    const rec = rowToRecord(id, row);
    // Lazy expiry: a claim past its TTL is shown as free again.
    if (rec.status === "claimed" && rec.claimExpiresAt && rec.claimExpiresAt < now) {
      rec.status = "new";
      rec.claimedBy = null;
      rec.claimedByName = null;
    }
    if (rec.status === "keyed" && !opts.includeKeyed) return;
    out.push(rec);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Writes — ingestion
// ---------------------------------------------------------------------------

/** Has this exact email already been turned into an order? (dedupe by message id) */
export async function alreadyIngested(internetMessageId: string): Promise<boolean> {
  return (await redis.exists(msgKey(internetMessageId))) === 1;
}

/** Find an earlier order with the same debtor + PO (a likely duplicate order). */
export async function findDuplicate(debtorCode: string | null, poRef: string | null) {
  if (!debtorCode || !poRef) return null;
  return await redis.get<string>(dupeKey(debtorCode, poRef));
}

/** Create one order record from extracted data. Safe to call repeatedly: it
 *  no-ops if the source email was already ingested. */
export async function createOrder(data: OrderData): Promise<string> {
  if (await alreadyIngested(data.internetMessageId)) {
    return (await redis.get<string>(msgKey(data.internetMessageId)))!;
  }
  const id = crypto.randomUUID();
  const duplicateOf = data.duplicateOf ?? (await findDuplicate(data.debtorCode, data.poRef));

  await redis.hset(orderKey(id), {
    data: JSON.stringify({ ...data, duplicateOf }),
    status: "new",
    claimedBy: "",
    claimedByName: "",
    claimAt: "0",
    claimExpiresAt: "0",
    keyedBy: "",
    keyedByName: "",
    keyedAt: "0",
  });
  await redis.zadd(INDEX, { score: data.receivedAt, member: id });
  await redis.set(msgKey(data.internetMessageId), id);
  if (data.debtorCode && data.poRef) {
    // First order for this debtor+PO becomes the "original" others point at.
    await redis.set(dupeKey(data.debtorCode, data.poRef), id, { nx: true });
  }
  return id;
}

// ---------------------------------------------------------------------------
// Atomic claim / release / key / heartbeat
// ---------------------------------------------------------------------------

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "closed" | "not_owner" | "already_keyed" }
  | { ok: false; reason: "taken"; by: string };

const CLAIM_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then return 'NOT_FOUND' end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'keyed' then return 'CLOSED' end
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

const HEARTBEAT_LUA = `
local owner = redis.call('HGET', KEYS[1], 'claimedBy')
local status = redis.call('HGET', KEYS[1], 'status')
if owner ~= ARGV[1] or status ~= 'claimed' then return 'NOT_OWNER' end
local now = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'claimExpiresAt', tostring(now + tonumber(ARGV[3])))
return 'OK'
`;

export async function claimOrder(id: string, userId: string, userName: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(
    CLAIM_LUA,
    [orderKey(id)],
    [userId, userName, String(Date.now()), String(CLAIM_TTL_MS)]
  )) as string;
  if (res === "OK") return { ok: true };
  if (res === "NOT_FOUND") return { ok: false, reason: "not_found" };
  if (res === "CLOSED") return { ok: false, reason: "closed" };
  if (res.startsWith("TAKEN:")) return { ok: false, reason: "taken", by: res.slice(6) };
  return { ok: false, reason: "not_found" };
}

export async function releaseOrder(id: string, userId: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(RELEASE_LUA, [orderKey(id)], [userId])) as string;
  return res === "OK" ? { ok: true } : { ok: false, reason: "not_owner" };
}

export async function markKeyed(id: string, userId: string, userName: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(KEY_LUA, [orderKey(id)], [userId, userName, String(Date.now())])) as string;
  if (res === "OK") return { ok: true };
  if (res === "ALREADY_KEYED") return { ok: false, reason: "already_keyed" };
  return { ok: false, reason: "not_owner" };
}

export async function heartbeat(id: string, userId: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(
    HEARTBEAT_LUA,
    [orderKey(id)],
    [userId, String(Date.now()), String(CLAIM_TTL_MS)]
  )) as string;
  return res === "OK" ? { ok: true } : { ok: false, reason: "not_owner" };
}
