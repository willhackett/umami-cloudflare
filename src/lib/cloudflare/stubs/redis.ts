// The node-redis driver is never used on Cloudflare (see src/lib/cloudflare/redis.ts).
export type RedisClientType = never;

export function createClient(): never {
  throw new Error(
    '[umami-cloudflare] Redis is not supported on Cloudflare; bind a KV namespace as CACHE instead.',
  );
}
