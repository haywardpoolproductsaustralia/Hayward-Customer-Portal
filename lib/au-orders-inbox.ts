import { redis } from "@/lib/redis";

/**
 * au-orders inbox — sales order intake queue.
 *
 * These are inbound CUSTOMER sales orders (SORMAST/SORTRAN) arriving by email in
 * Staff review them here and key them into Arrow as SALES orders. This is a
 * SEPARATE feature from the portal's existing sales-orders ("Orders") page.
 *
 * Keyspace: everything lives under `soq:` so it can never touch the sales-order
 * data, which lives under `orders:*`. Reuses the shared client from lib/redis.
 *
 * The claim/lock that stops two staff keying the same order is enforced by the Lua
 * scripts below; Lua runs atomically inside Redis, so a "check then take"
 * sequence can't be interleaved by a second person.
 */

export const CLAIM_TTL_MS = 20 * 60 * 1000; // 20 minutes

export type IntakeStatus = "new" | "claimed" | "keyed";

export interface IntakeLine {
  raw: string;
  sku: string | null;
  description: string | null;
  qty: number | null;
  unit: string | null;
  claimedPrice: number | null;
  confidence: "high" | "low";
}

/** Immutable payload from extraction. Stored as JSON in the `data` field. */
export interface IntakeData {
  internetMessageId: string;
  receivedAt: number;
  emailWebUrl: string | null;
  fromEmail: string;
  fromName: string | null;
  debtorCode: string | null;
  debtorName: string | null;
  poRef: string | null;
  deliverBy: string | null;
  deliverTo: string | null;
  contact: string | null;
  lines: IntakeLine[];
  notes: string | null;
  extractionConfidence: "high" | "low";
  duplicateOf: string | null;
}

export interface IntakeRecord extends IntakeData {
  id: string;
  status: IntakeStatus;
  claimedBy: string | null;
  claimedByName: string | null;
  claimAt: number | null;
  claimExpiresAt: number | null;
  keyedBy: string | null;
  keyedByName: string | null;
  keyedAt: number | null;
}

const itemKey = (id: string) => `soq:${id}`;
const INDEX = "soq:index";                          // sorted set: score=receivedAt, member=id
const dupeKey = (debtor: string, ref: string) => `soq:dupe:${debtor}:${ref}`;
const msgKey = (msgId: string) => `soq:msg:${msgId}`;

function rowToRecord(id: string, h: Record<string, unknown>): IntakeRecord {
  const data = (typeof h.data === "string" ? JSON.parse(h.data) : h.data) as IntakeData;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    id,
    ...data,
    status: (h.status as IntakeStatus) ?? "new",
    claimedBy: (h.claimedBy as string) || null,
    claimedByName: (h.claimedByName as string) || null,
    claimAt: num(h.claimAt),
    claimExpiresAt: num(h.claimExpiresAt),
    keyedBy: (h.keyedBy as string) || null,
    keyedByName: (h.keyedByName as string) || null,
    keyedAt: num(h.keyedAt),
  };
}

/** List POs newest-first. Hides ones already keyed into Arrow unless asked. */
export async function listIntake(opts: { includeKeyed?: boolean } = {}): Promise<IntakeRecord[]> {
  const ids = await redis.zrange<string[]>(INDEX, 0, -1, { rev: true });
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.hgetall(itemKey(id)));
  const rows = (await pipe.exec()) as Array<Record<string, unknown> | null>;

  const now = Date.now();
  const out: IntakeRecord[] = [];
  ids.forEach((id, i) => {
    const row = rows[i];
    if (!row) return;
    const rec = rowToRecord(id, row);
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

export async function alreadyIngested(internetMessageId: string): Promise<boolean> {
  return (await redis.exists(msgKey(internetMessageId))) === 1;
}

export async function findDuplicate(debtorCode: string | null, poRef: string | null) {
  if (!debtorCode || !poRef) return null;
  return await redis.get<string>(dupeKey(debtorCode, poRef));
}

/** Create one order record. No-ops if the source email was already ingested. */
export async function createIntake(data: IntakeData): Promise<string> {
  if (await alreadyIngested(data.internetMessageId)) {
    return (await redis.get<string>(msgKey(data.internetMessageId)))!;
  }
  const id = crypto.randomUUID();
  const duplicateOf = data.duplicateOf ?? (await findDuplicate(data.debtorCode, data.poRef));

  await redis.hset(itemKey(id), {
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
    await redis.set(dupeKey(data.debtorCode, data.poRef), id, { nx: true });
  }
  return id;
}

// --- atomic claim / release / key / heartbeat -----------------------------

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

export async function claimIntake(id: string, userId: string, userName: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(CLAIM_LUA, [itemKey(id)], [userId, userName, String(Date.now()), String(CLAIM_TTL_MS)])) as string;
  if (res === "OK") return { ok: true };
  if (res === "NOT_FOUND") return { ok: false, reason: "not_found" };
  if (res === "CLOSED") return { ok: false, reason: "closed" };
  if (res.startsWith("TAKEN:")) return { ok: false, reason: "taken", by: res.slice(6) };
  return { ok: false, reason: "not_found" };
}

export async function releaseIntake(id: string, userId: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(RELEASE_LUA, [itemKey(id)], [userId])) as string;
  return res === "OK" ? { ok: true } : { ok: false, reason: "not_owner" };
}

export async function markKeyed(id: string, userId: string, userName: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(KEY_LUA, [itemKey(id)], [userId, userName, String(Date.now())])) as string;
  if (res === "OK") return { ok: true };
  if (res === "ALREADY_KEYED") return { ok: false, reason: "already_keyed" };
  return { ok: false, reason: "not_owner" };
}

export async function heartbeatIntake(id: string, userId: string): Promise<ClaimOutcome> {
  const res = (await redis.eval(HEARTBEAT_LUA, [itemKey(id)], [userId, String(Date.now()), String(CLAIM_TTL_MS)])) as string;
  return res === "OK" ? { ok: true } : { ok: false, reason: "not_owner" };
}
