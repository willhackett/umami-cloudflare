/**
 * Rows whose values are too big for one D1 statement are exported as an INSERT
 * followed by `col = col || slice` UPDATEs. Prove that the statements round-trip
 * byte for byte on the workerd SQLite that D1 runs.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parsePrismaSchema, rowStatements } from '../../scripts/cloudflare/pg-to-d1.ts';
import { type D1TestContext, startD1 } from './d1';

let ctx: D1TestContext;

beforeAll(async () => {
  ctx = await startD1();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('wide rows', () => {
  test('a 300 KB replay blob and a 200 KB text value survive sliced import', async () => {
    const schema = parsePrismaSchema(
      readFileSync(path.resolve(import.meta.dirname, '../../prisma/schema.sqlite.prisma'), 'utf8'),
    );
    const replay = schema.find(t => t.name === 'session_replay');
    const eventData = schema.find(t => t.name === 'event_data');
    if (!replay || !eventData) throw new Error('schema tables missing');

    const blob = randomBytes(300_000);
    const replayCols = replay.columns;
    const replayRow = replayCols.map(c => {
      switch (c.name) {
        case 'replay_id':
          return 'r-wide';
        case 'website_id':
        case 'session_id':
        case 'visit_id':
          return 'x';
        case 'chunk_index':
        case 'event_count':
          return 1;
        case 'events':
          return blob;
        default:
          return '2024-01-01T00:00:00.000+00:00';
      }
    });
    const header = (t: typeof replay) =>
      `INSERT OR REPLACE INTO "${t.name}" (${t.columns.map(c => `"${c.name}"`).join(', ')}) VALUES\n`;

    const r = rowStatements(replay, replayCols, replayRow, header(replay));
    if (!('statements' in r)) throw new Error('expected sliced statements');
    expect(r.statements.length).toBeGreaterThan(3);
    for (const s of r.statements) {
      expect(Buffer.byteLength(s)).toBeLessThan(100_000);
      await ctx.db.prepare(s).run();
    }
    const stored = await ctx.db
      .prepare('select events, length(events) as len from session_replay where replay_id = ?')
      .bind('r-wide')
      .first<{ events: ArrayBuffer; len: number }>();
    expect(stored?.len).toBe(blob.length);
    expect(Buffer.from(stored?.events as ArrayBuffer).equals(blob)).toBe(true);

    const text = `${"quote'".repeat(10_000)}${'ünïcödé'.repeat(20_000)}`;
    const edCols = eventData.columns;
    const edRow = edCols.map(c => {
      switch (c.name) {
        case 'event_data_id':
          return 'ed-wide';
        case 'website_id':
        case 'website_event_id':
          return 'x';
        case 'data_key':
          return 'k';
        case 'data_type':
          return 1;
        case 'string_value':
          return text;
        case 'created_at':
          return '2024-01-01T00:00:00.000+00:00';
        default:
          return null;
      }
    });
    const e = rowStatements(eventData, edCols, edRow, header(eventData));
    if (!('statements' in e)) throw new Error('expected sliced statements');
    for (const s of e.statements) {
      expect(Buffer.byteLength(s)).toBeLessThan(100_000);
      await ctx.db.prepare(s).run();
    }
    const row = await ctx.db
      .prepare('select string_value from event_data where event_data_id = ?')
      .bind('ed-wide')
      .first<{ string_value: string }>();
    expect(row?.string_value).toBe(text);
  });
});
