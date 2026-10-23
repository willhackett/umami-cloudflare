import { describe, expect, test } from 'vitest';
import { parsePrismaSchema, toSqliteLiteral } from './pg-to-d1.ts';

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
      },
      {
        name: 'Team',
        columns: [
          { name: 'id', type: 'String' },
          { name: 'name', type: 'String' },
        ],
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
