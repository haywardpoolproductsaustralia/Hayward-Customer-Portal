import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * The sync job always writes JSON.stringify()'d values. Upstash's client
 * sometimes auto-parses JSON strings on read and sometimes returns the raw
 * string, depending on version - this handles both so the rest of the app
 * doesn't have to think about it.
 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const value = await redis.get<T | string>(key);
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

