/**
 * Drop-in replacement for src/lib/redis.ts backed by Workers KV.
 *
 * Wired in through tsconfig `paths` + turbopack `resolveAlias` so upstream code
 * importing `@/lib/redis` gets this module without modification.
 *
 * Caveats vs Redis:
 *  - KV is eventually consistent (writes take up to ~60s to be visible in other
 *    locations) and the minimum TTL is 60 seconds.
 *  - incr/rateLimit are read-modify-write, not atomic. umami only uses
 *    get/set/del/expire/fetch, so this is acceptable.
 *
 * The cache is enabled only when a KV namespace is bound as `CACHE`.
 */
import debug from 'debug';
import { getKVCache } from './env';

const log = debug('umami:kv-cache');

export const DELETED = '__DELETED__';
export const DEFAULT_TTL = 3600;
const MIN_TTL = 60;

function ttl(time?: number) {
  const value = time && time > 0 ? time : DEFAULT_TTL;
  return Math.max(MIN_TTL, Math.floor(value));
}

class UmamiKVClient {
  get isConnected() {
    return !!getKVCache();
  }

  get isOpen() {
    return this.isConnected;
  }

  get isReady() {
    return this.isConnected;
  }

  on() {
    return this;
  }

  async connect() {
    /* no-op */
  }

  async get(key: string) {
    const kv = getKVCache();
    if (!kv) return null;

    try {
      return await kv.get(key, 'json');
    } catch (err) {
      log(err);
      return null;
    }
  }

  async set(key: string, value: any, time?: number) {
    const kv = getKVCache();
    if (!kv) return null;

    await kv.put(key, JSON.stringify(value ?? null), { expirationTtl: ttl(time) });

    return 'OK';
  }

  async del(key: string) {
    const kv = getKVCache();
    if (!kv) return 0;

    await kv.delete(key);

    return 1;
  }

  async incr(key: string) {
    const current = Number((await this.get(key)) ?? 0) + 1;
    await this.set(key, current);
    return current;
  }

  async expire(key: string, seconds: number) {
    const value = await this.get(key);
    if (value === null || value === undefined) return false;

    await this.set(key, value, seconds);

    return true;
  }

  async rateLimit(key: string, limit: number, seconds: number): Promise<boolean> {
    const res = await this.incr(key);

    if (res === 1) {
      await this.expire(key, seconds);
    }

    return res >= limit;
  }

  async fetch(key: string, query: () => Promise<any>, time?: number) {
    const result = await this.get(key);

    if (result === DELETED) return null;

    if (!result && query) {
      const data = await query();
      if (data) {
        await this.set(key, data, time);
      }
      return data;
    }

    return result;
  }

  async remove(key: string, soft = false) {
    return soft ? this.set(key, DELETED) : this.del(key);
  }
}

const client = new UmamiKVClient();

const redis = {
  client,
  get enabled() {
    return !!getKVCache();
  },
};

export default redis;
