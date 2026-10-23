/**
 * Test harness: boots a local D1 database through wrangler's getPlatformProxy
 * (the same workerd/SQLite build that `wrangler dev` uses), applies the D1
 * migrations and injects the bindings into the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import { resetD1Client } from '@/lib/cloudflare/d1';
import { setCloudflareEnv, type UmamiCloudflareEnv } from '@/lib/cloudflare/env';

const root = path.resolve(import.meta.dirname, '../..');

export interface D1TestContext {
  env: UmamiCloudflareEnv;
  db: D1Database;
  dispose: () => Promise<void>;
}

export function readMigrations(): string[] {
  const dir = path.join(root, 'prisma/migrations-d1');
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  return files.flatMap(file =>
    fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean),
  );
}

export async function applyMigrations(db: D1Database) {
  for (const statement of readMigrations()) {
    await db.prepare(statement).run();
  }
}

export async function startD1(): Promise<D1TestContext> {
  process.env.DATABASE_URL = 'd1://DB';
  process.env.APP_SECRET ||= 'test-secret';
  process.env.SKIP_DB_CHECK = '1';

  const proxy: PlatformProxy<UmamiCloudflareEnv> = await getPlatformProxy<UmamiCloudflareEnv>({
    configPath: path.join(root, 'wrangler.jsonc'),
    persist: false,
  });

  const env = proxy.env;
  await applyMigrations(env.DB);

  resetD1Client();
  setCloudflareEnv(env);

  return {
    env,
    db: env.DB,
    dispose: async () => {
      setCloudflareEnv(null);
      resetD1Client();
      await proxy.dispose();
    },
  };
}
