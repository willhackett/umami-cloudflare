/**
 * Access to Cloudflare bindings (D1, KV, ...) from anywhere in the app.
 *
 * In the Worker (and in `next dev` via initOpenNextCloudflareForDev) bindings come
 * from OpenNext's request context. Tests can inject an env (e.g. from wrangler's
 * getPlatformProxy()) with setCloudflareEnv().
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';

const ENV_KEY = '__umamiCloudflareEnv';

export interface UmamiCloudflareEnv {
  DB: D1Database;
  CACHE?: KVNamespace;
  [key: string]: unknown;
}

export function setCloudflareEnv(env: UmamiCloudflareEnv | null) {
  (globalThis as Record<string, unknown>)[ENV_KEY] = env ?? undefined;
}

export function getCloudflareEnv(): UmamiCloudflareEnv {
  const injected = (globalThis as Record<string, unknown>)[ENV_KEY] as
    | UmamiCloudflareEnv
    | undefined;

  if (injected) {
    return injected;
  }

  try {
    return getCloudflareContext().env as unknown as UmamiCloudflareEnv;
  } catch (error) {
    throw new Error(
      '[umami-cloudflare] Cloudflare bindings are not available. Run with `wrangler dev`/`next dev` (initOpenNextCloudflareForDev) or call setCloudflareEnv() in tests.',
      { cause: error },
    );
  }
}

/** Name of the D1 binding, taken from DATABASE_URL (`d1://BINDING`, default `DB`). */
export function getD1BindingName(url = process.env.DATABASE_URL): string {
  const match = /^d1:\/\/([\w-]*)/i.exec(url ?? '');
  return match?.[1] || 'DB';
}

export function getD1Database(): D1Database {
  const env = getCloudflareEnv();
  const name = getD1BindingName();
  const binding = env[name] as D1Database | undefined;

  if (!binding || typeof binding.prepare !== 'function') {
    throw new Error(
      `[umami-cloudflare] D1 binding "${name}" not found. Check wrangler.jsonc d1_databases.`,
    );
  }

  return binding;
}

export function getKVCache(): KVNamespace | null {
  try {
    const env = getCloudflareEnv();
    const binding = env.CACHE;
    return binding && typeof binding.get === 'function' ? binding : null;
  } catch {
    return null;
  }
}
