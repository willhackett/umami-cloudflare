/**
 * Runs umami's queries against data that `pnpm cf:migrate:export` /
 * `pnpm cf:migrate:import --local` moved from a Postgres instance into the local D1
 * state. Skipped when no migration manifest exists.
 *
 *   MIGRATION_DIR=.wrangler/migration pnpm cf:test -- tests/cloudflare/migrated-data.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Manifest } from '../../scripts/cloudflare/pg-to-d1.ts';
import { type D1TestContext, startD1 } from './d1';

const root = path.resolve(import.meta.dirname, '../..');
const migrationDir = path.resolve(root, process.env.MIGRATION_DIR ?? '.wrangler/migration');
const manifestPath = path.join(migrationDir, 'manifest.json');
const hasMigration = fs.existsSync(manifestPath);

describe.skipIf(!hasMigration)('queries over migrated Postgres data', () => {
  let ctx: D1TestContext;
  let sql: typeof import('@/queries/sql');
  let manifest: Manifest;
  let websites: { website_id: string; name: string }[];

  const wide = () => ({
    startDate: new Date('2000-01-01T00:00:00Z'),
    endDate: new Date('2100-01-01T00:00:00Z'),
    timezone: 'UTC',
    unit: 'day',
  });

  beforeAll(async () => {
    ctx = await startD1({ persist: true });
    sql = await import('@/queries/sql');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    websites = (await ctx.db.prepare('select website_id, name from website').all()).results as any;
  });

  afterAll(async () => {
    await ctx?.dispose();
  });

  test('row counts are at least what the export produced', async () => {
    for (const table of manifest.tables.filter(t => t.rows > 0)) {
      const row = await ctx.db
        .prepare(`select count(*) as c from "${table.name}"`)
        .first<{ c: number }>();
      expect(row?.c, table.name).toBeGreaterThanOrEqual(table.rows);
    }
  });

  test('timestamps were written in the canonical D1 format', async () => {
    const row = await ctx.db
      .prepare(
        `select count(*) as bad from website_event
         where length(created_at) != 29 or substr(created_at, 11, 1) != 'T' or substr(created_at, 24) != '+00:00'
            or created_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'`,
      )
      .first<{ bad: number }>();
    expect(row?.bad).toBe(0);
  });

  test('stats, pageviews, metrics and sessions match the raw tables per website', async () => {
    expect(websites.length).toBeGreaterThan(0);

    for (const { website_id: websiteId } of websites) {
      const raw = await ctx.db
        .prepare(
          `select sum(event_type = 1) as pageviews, count(distinct session_id) as visitors, count(distinct visit_id) as visits
           from website_event where website_id = ?`,
        )
        .bind(websiteId)
        .first<{ pageviews: number; visitors: number; visits: number }>();
      if (!raw?.pageviews) continue;

      const stats: any = await sql.getWebsiteStats(websiteId, wide() as any);
      expect(Number(stats.pageviews)).toBe(raw.pageviews);
      expect(Number(stats.visitors)).toBe(raw.visitors);
      expect(Number(stats.visits)).toBe(raw.visits);

      const series: any[] = await sql.getPageviewStats(websiteId, wide() as any);
      expect(series.reduce((n, r) => n + Number(r.y), 0)).toBe(raw.pageviews);

      const paths: any[] = await sql.getPageviewMetrics(
        websiteId,
        { type: 'path', limit: 10000 },
        wide() as any,
      );
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.reduce((n, r) => n + Number(r.y), 0)).toBe(raw.pageviews);

      const sessions: any = await sql.getWebsiteSessions(websiteId, {
        ...wide(),
        pageSize: 5,
      } as any);
      expect(sessions.data.length).toBeGreaterThan(0);
      expect(Number(sessions.count)).toBe(raw.visitors);
    }
  });

  test('revenue totals match', async () => {
    const totals = (
      await ctx.db
        .prepare(
          'select website_id, currency, sum(revenue) as total, count(distinct event_id) as n from revenue group by 1, 2',
        )
        .all()
    ).results as { website_id: string; currency: string; total: number; n: number }[];

    for (const row of totals) {
      const { getRevenueStats } = await import('@/queries/sql/revenue/getRevenueStats');
      const stats: any = await getRevenueStats(
        row.website_id,
        { ...wide(), currency: row.currency } as any,
        wide() as any,
      );
      expect(Number(stats.sum)).toBeCloseTo(Number(row.total), 2);
      expect(Number(stats.count)).toBe(row.n);
    }
  });
});
