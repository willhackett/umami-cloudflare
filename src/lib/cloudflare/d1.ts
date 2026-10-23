/**
 * Prisma client backed by Cloudflare D1, plus raw query execution with
 * Postgres -> SQLite translation.
 *
 * The client is created lazily on first use because bindings are only reachable
 * inside a request (upstream creates its client at module load).
 */
import { PrismaD1 } from '@prisma/adapter-d1';
import debug from 'debug';
import { PrismaClient } from '@/generated/prisma/client';
import { getD1Database } from './env';
import { postProcessRows, translateQuery, translateUnsafe } from './sql/translate';

const log = debug('umami:d1');

const CLIENT_KEY = '__umamiD1PrismaClient';

type AnyClient = PrismaClient & Record<string | symbol, unknown>;

function getRealClient(): AnyClient {
  const g = globalThis as Record<string, unknown>;

  if (!g[CLIENT_KEY]) {
    const adapter = new PrismaD1(getD1Database());
    g[CLIENT_KEY] = new PrismaClient({ adapter, errorFormat: 'pretty' });
    log('Prisma (D1) initialized');
  }

  return g[CLIENT_KEY] as AnyClient;
}

/** Drop the cached client (tests swap bindings between runs). */
export function resetD1Client() {
  delete (globalThis as Record<string, unknown>)[CLIENT_KEY];
}

/**
 * D1 has no interactive transactions. Batch transactions map onto D1 batch;
 * callback transactions run against the plain client (non-atomic).
 */
async function emulatedTransaction(proxy: PrismaClient, input: unknown, options?: unknown) {
  if (typeof input === 'function') {
    // Hand the callback the proxy so raw statements inside it are translated too.
    return (input as (tx: unknown) => Promise<unknown>)(proxy);
  }

  const client = getRealClient();

  return (client.$transaction as (i: unknown, o?: unknown) => Promise<unknown>)(input, options);
}

/** A PrismaClient-shaped proxy that resolves the real client on first access. */
export function createLazyD1Client(): PrismaClient {
  const proxy: PrismaClient = new Proxy({} as PrismaClient, {
    get(_target, prop) {
      if (prop === '$transaction') {
        return (input: unknown, options?: unknown) => emulatedTransaction(proxy, input, options);
      }

      if (prop === 'then') {
        // never behave like a thenable
        return undefined;
      }

      // Upstream occasionally runs Postgres SQL straight through Prisma's raw
      // methods (e.g. `delete ... using` in deleteWebsiteDependentData). Translate
      // those the same way runD1RawQuery translates umami's {{param}} queries.
      if (prop === '$executeRawUnsafe' || prop === '$queryRawUnsafe') {
        return (sql: string, ...values: unknown[]) => {
          if (/^\s*set\s+search_path\b/i.test(sql)) return Promise.resolve(0);
          const { sql: translated, params } = translateUnsafe(sql, values);
          const client = getRealClient();
          return prop === '$executeRawUnsafe'
            ? client.$executeRawUnsafe(translated, ...params)
            : client.$queryRawUnsafe(translated, ...params);
        };
      }

      const client = getRealClient();
      const value = Reflect.get(client, prop);

      return typeof value === 'function' ? value.bind(client) : value;
    },
  });

  return proxy;
}

/**
 * Execute one of umami's Postgres raw queries against D1.
 * `sql` uses upstream's `{{param}}` placeholders.
 */
export async function runD1RawQuery(
  sql: string,
  data: Record<string, unknown>,
  name?: string,
): Promise<any> {
  const { sql: translated, params, jsonColumns } = translateQuery(sql, data);

  if (process.env.LOG_QUERY) {
    log('NAME:', name);
    log('SQLITE QUERY:\n', translated);
    log('PARAMETERS:\n', params);
  }

  const client = getRealClient();
  const rows = await client.$queryRawUnsafe(translated, ...params);

  return postProcessRows(rows as Record<string, unknown>[], jsonColumns);
}
