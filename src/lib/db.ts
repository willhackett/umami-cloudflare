export const PRISMA = 'prisma';
export const POSTGRESQL = 'postgresql';
export const CLICKHOUSE = 'clickhouse';
export const KAFKA = 'kafka';
export const KAFKA_PRODUCER = 'kafka-producer';
// umami-cloudflare: Cloudflare D1 (SQLite). DATABASE_URL=d1://<binding>
export const D1 = 'd1';

// Fixes issue with converting bigint values
(BigInt.prototype as unknown as { toJSON(): number }).toJSON = function () {
  return Number(this);
};

export function getDatabaseType(url = process.env.DATABASE_URL) {
  const type = url?.split(':')[0];

  if (type === 'postgres') {
    return POSTGRESQL;
  }

  return type;
}

export function isD1(url = process.env.DATABASE_URL) {
  return getDatabaseType(url) === D1;
}

export function isRelationalOnly() {
  return !process.env.CLICKHOUSE_URL && [POSTGRESQL, D1].includes(getDatabaseType());
}

export async function runQuery(queries: any) {
  if (process.env.CLICKHOUSE_URL) {
    if (queries[KAFKA]) {
      return queries[KAFKA]();
    }

    return queries[CLICKHOUSE]();
  }

  const db = getDatabaseType();

  if (db === POSTGRESQL || db === D1) {
    return queries[PRISMA]();
  }
}

export function notImplemented() {
  throw new Error('Not implemented.');
}
