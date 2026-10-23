import { describe, expect, test } from 'vitest';
import {
  MAX_LITERAL_BYTES,
  parsePrismaSchema,
  rowStatements,
  sliceLiteral,
  toSqliteLiteral,
} from './pg-to-d1.ts';

describe('parsePrismaSchema', () => {
  test('extracts tables, mapped columns and scalar types, skipping relations', () => {
    const schema = `
model EventData {
  id             String    @id() @map("event_data_id")
  websiteId      String    @map("website_id")
  stringValue    String?   @map("string_value")
  numberValue    Decimal?  @map("number_value")
  dateValue      DateTime? @map("date_value")
  dataType       Int       @map("data_type")
  createdAt      DateTime? @default(now()) @map("created_at")
  plain          Boolean

  website      Website      @relation(fields: [websiteId], references: [id])
  events       WebsiteEvent[]

  @@index([createdAt])
  @@map("event_data")
}

model Team {
  id   String @id
  name String
}

model SessionLink {
  websiteId  String @map("website_id")
  distinctId String @map("distinct_id")
  sessionId  String @map("session_id")

  @@id([websiteId, distinctId, sessionId])
  @@map("session_link")
}
`;
    expect(parsePrismaSchema(schema)).toEqual([
      {
        name: 'event_data',
        columns: [
          { name: 'event_data_id', type: 'String' },
          { name: 'website_id', type: 'String' },
          { name: 'string_value', type: 'String' },
          { name: 'number_value', type: 'Decimal' },
          { name: 'date_value', type: 'DateTime' },
          { name: 'data_type', type: 'Int' },
          { name: 'created_at', type: 'DateTime' },
          { name: 'plain', type: 'Boolean' },
        ],
        primaryKey: ['event_data_id'],
      },
      {
        name: 'Team',
        columns: [
          { name: 'id', type: 'String' },
          { name: 'name', type: 'String' },
        ],
        primaryKey: ['id'],
      },
      {
        name: 'session_link',
        columns: [
          { name: 'website_id', type: 'String' },
          { name: 'distinct_id', type: 'String' },
          { name: 'session_id', type: 'String' },
        ],
        primaryKey: ['website_id', 'distinct_id', 'session_id'],
      },
    ]);
  });
});

describe('toSqliteLiteral', () => {
  test('converts values to the D1 representation', () => {
    expect(toSqliteLiteral(null, 'String')).toBe('NULL');
    expect(toSqliteLiteral("O'Reilly", 'String')).toBe("'O''Reilly'");
    expect(toSqliteLiteral(true, 'Boolean')).toBe('1');
    expect(toSqliteLiteral(false, 'Boolean')).toBe('0');
    expect(toSqliteLiteral(42, 'Int')).toBe('42');
    expect(toSqliteLiteral('13110.0000', 'Decimal')).toBe('13110.0000');
    expect(toSqliteLiteral('9007199254740993', 'BigInt')).toBe('9007199254740993');
    expect(toSqliteLiteral('{"a":1}', 'Json')).toBe(`'{"a":1}'`);
    expect(toSqliteLiteral({ a: 1 }, 'Json')).toBe(`'{"a":1}'`);
    expect(toSqliteLiteral(Buffer.from([1, 255]), 'Bytes')).toBe("X'01ff'");
    expect(toSqliteLiteral('2024-03-05T10:00:00.123+00:00', 'DateTime')).toBe(
      "'2024-03-05T10:00:00.123+00:00'",
    );
  });
});

describe('wide values', () => {
  test('sliceLiteral keeps small values whole and splits big ones on safe boundaries', () => {
    expect(sliceLiteral('abc', 'String')).toEqual(["'abc'"]);

    const blob = Buffer.alloc(100_000, 0xab);
    const blobSlices = sliceLiteral(blob, 'Bytes', 1000);
    expect(blobSlices.length).toBeGreaterThan(100);
    expect(blobSlices[0]).toMatch(/^X'(?:[0-9a-f]{2})+'$/);
    for (const s of blobSlices.slice(1)) {
      expect(Buffer.byteLength(s)).toBeLessThanOrEqual(1000);
      expect(s).toMatch(/^'(?:[0-9a-f]{2})+'$/);
    }
    const hex = blobSlices.map((s, i) => (i === 0 ? s.slice(2, -1) : s.slice(1, -1))).join('');
    expect(Buffer.from(hex, 'hex').equals(blob)).toBe(true);

    const text = "it's ".repeat(400) + 'é'.repeat(400);
    const textSlices = sliceLiteral(text, 'String', 300);
    for (const s of textSlices) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(300);
    expect(textSlices.map(s => s.slice(1, -1).replace(/''/g, "'")).join('')).toBe(text);
  });

  test('rowStatements emits an insert plus appends keyed by the primary key', () => {
    const table = {
      name: 'session_replay',
      columns: [
        { name: 'replay_id', type: 'String' },
        { name: 'events', type: 'Bytes' },
      ],
      primaryKey: ['replay_id'],
    };
    const header = 'INSERT OR REPLACE INTO "session_replay" ("replay_id", "events") VALUES\n';
    const small = rowStatements(table, table.columns, ['r1', Buffer.from([1, 2])], header);
    expect(small).toEqual({ tuple: "('r1', X'0102')" });

    const big = rowStatements(
      table,
      table.columns,
      ['r2', Buffer.alloc(MAX_LITERAL_BYTES, 1)],
      header,
    );
    expect('statements' in big).toBe(true);
    const { statements } = big as { statements: string[] };
    expect(statements.length).toBeGreaterThan(1);
    expect(statements[0].startsWith(header)).toBe(true);
    expect(statements[1]).toMatch(
      /^UPDATE "session_replay" SET "events" = unhex\(hex\("events"\) \|\| '[0-9a-f]+'\) WHERE "replay_id" = 'r2';\n$/,
    );
    for (const s of statements) expect(Buffer.byteLength(s)).toBeLessThan(90_000);
  });
});
