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
import { postProcessRows, translateQuery } from './sql/translate';

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
async function emulatedTransaction(input: unknown, options?: unknown) {
  const client = getRealClient();

  if (typeof input === 'function') {
    return (input as (tx: unknown) => Promise<unknown>)(client);
  }

  return (client.$transaction as (i: unknown, o?: unknown) => Promise<unknown>)(input, options);
}

/** A PrismaClient-shaped proxy that resolves the real client on first access. */
export function createLazyD1Client(): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, prop) {
      if (prop === '$transaction') {
        return emulatedTransaction;
      }

      if (prop === 'then') {
        // never behave like a thenable
        return undefined;
      }

      const client = getRealClient();
      const value = Reflect.get(client, prop);

      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
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
