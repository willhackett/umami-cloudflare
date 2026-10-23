/**
 * Export an existing umami Postgres database as SQLite INSERT files that can be
 * loaded into Cloudflare D1 (see import-d1-dump.ts / `pnpm cf:migrate:import`).
 *
 *   pnpm cf:migrate:export --source postgresql://user:pass@host:5432/umami [--out .wrangler/migration]
 *                           [--tables website,website_event] [--exclude session_replay]
 *                           [--rows-per-statement 500] [--max-file-mb 100]
 *
 * The table and column list is derived from prisma/schema.sqlite.prisma, so the
 * export always matches the D1 schema of this checkout. Values are converted to the
 * representation the Cloudflare runtime expects (timestamps as
 * YYYY-MM-DDTHH:MM:SS.SSS+00:00, booleans as 0/1, JSON and decimals as text).
 * Statements use INSERT OR REPLACE, so re-running an import is idempotent.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  type WriteStream,
} from 'node:fs';
import path from 'node:path';
import { Client, types } from 'pg';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCHEMA_PATH = path.join(ROOT, 'prisma/schema.sqlite.prisma');

// D1 limits: 100 KB per statement, 5 GB per imported file.
const MAX_STATEMENT_BYTES = 90_000;
// A single literal (a session replay blob, a long JSON value) can be bigger than a
// statement is allowed to be. Such values are inserted in slices: the row goes in
// with the first slice and the rest is appended with `col = col || <slice>`.
export const MAX_LITERAL_BYTES = 80_000;
const FETCH_SIZE = 2_000;

const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
]);

export interface Column {
  name: string;
  type: string;
}

export interface Table {
  name: string;
  columns: Column[];
  /** Column names of the primary key (needed to append slices of wide values). */
  primaryKey: string[];
}

export interface Manifest {
  generatedAt: string;
  source: string;
  tables: { name: string; rows: number; files: string[] }[];
  files: string[];
}

interface Options {
  source: string;
  out: string;
  tables?: string[];
  exclude: string[];
  rowsPerStatement: number;
  maxFileBytes: number;
}

/** Parse the models of a Prisma schema into table/column lists. */
export function parsePrismaSchema(src: string): Table[] {
  const tables: Table[] = [];

  for (const match of src.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, modelName, body] = match;
    const columns: Column[] = [];
    const columnByField = new Map<string, string>();
    const idFields: string[] = [];
    let tableName = modelName;

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;

      const mapTable = /^@@map\("([^"]+)"\)/.exec(line);
      if (mapTable) {
        tableName = mapTable[1];
        continue;
      }
      const compoundId = /^@@id\(\[([^\]]+)\]/.exec(line);
      if (compoundId) {
        idFields.push(...compoundId[1].split(',').map(f => f.trim()));
        continue;
      }
      if (line.startsWith('@@')) continue;

      const field = /^(\w+)\s+(\w+)(\[\])?\??(?:\s|$)/.exec(line);
      if (!field) continue;
      const [, fieldName, type, isList] = field;
      if (isList || !SCALAR_TYPES.has(type) || line.includes('@relation(')) continue;

      const mapColumn = /@map\("([^"]+)"\)/.exec(line);
      const columnName = mapColumn ? mapColumn[1] : fieldName;
      columns.push({ name: columnName, type });
      columnByField.set(fieldName, columnName);
      if (/\s@id\b/.test(` ${line}`)) idFields.push(fieldName);
    }

    tables.push({
      name: tableName,
      columns,
      primaryKey: idFields.map(f => columnByField.get(f) ?? f),
    });
  }

  return tables;
}

/**
 * Split a value whose SQLite literal would exceed `maxBytes` into literals that
 * each fit. Text slices are appended with `col || slice`. Blob slices after the
 * first are hex *strings*, appended with `unhex(hex(col) || slice)`, because
 * SQLite's `||` turns blobs into text and truncates at the first NUL byte.
 * Values that fit come back as a single literal.
 */
export function sliceLiteral(value: unknown, type: string, maxBytes = MAX_LITERAL_BYTES): string[] {
  const whole = toSqliteLiteral(value, type);
  if (Buffer.byteLength(whole) <= maxBytes) return [whole];

  if (type === 'Bytes') {
    const hex = Buffer.from(value as Uint8Array).toString('hex');
    // keep slices on byte boundaries (two hex digits each)
    const step = Math.max(2, Math.floor((maxBytes - 3) / 2) * 2);
    const out: string[] = [];
    for (let i = 0; i < hex.length; i += step) {
      out.push(i === 0 ? `X'${hex.slice(i, i + step)}'` : `'${hex.slice(i, i + step)}'`);
    }
    return out;
  }

  // text (String / Json): cut on code points, counting the doubled quotes
  const text = type === 'Json' && typeof value !== 'string' ? JSON.stringify(value) : String(value);
  const out: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const ch of text) {
    const size = ch === "'" ? 2 : Buffer.byteLength(ch);
    if (bytes + size > maxBytes - 2 && piece) {
      out.push(quote(piece));
      piece = '';
      bytes = 0;
    }
    piece += ch;
    bytes += size;
  }
  if (piece || !out.length) out.push(quote(piece));
  return out;
}

/**
 * The statements for one row: a VALUES tuple when every literal fits in a
 * statement, otherwise an INSERT carrying the first slice of each wide value and
 * UPDATEs appending the remaining slices (all small enough for D1 on their own).
 */
export function rowStatements(
  table: Table,
  columns: Column[],
  row: unknown[],
  header: string,
): { tuple: string } | { statements: string[] } {
  const slices = row.map((v, i) => sliceLiteral(v, columns[i].type));
  if (slices.every(s => s.length === 1)) {
    return { tuple: `(${slices.map(s => s[0]).join(', ')})` };
  }

  if (!table.primaryKey.length) {
    throw new Error(
      `${table.name}: a value is too large for one D1 statement and the table has no primary key to append to`,
    );
  }
  const where = table.primaryKey
    .map(pk => {
      const i = columns.findIndex(c => c.name === pk);
      if (i < 0) throw new Error(`${table.name}: primary key column ${pk} not exported`);
      return `"${pk}" = ${slices[i][0]}`;
    })
    .join(' and ');

  const statements = [`${header}(${slices.map(s => s[0]).join(', ')});\n`];
  slices.forEach((parts, i) => {
    const col = `"${columns[i].name}"`;
    for (const part of parts.slice(1)) {
      const appended =
        columns[i].type === 'Bytes' ? `unhex(hex(${col}) || ${part})` : `${col} || ${part}`;
      statements.push(`UPDATE "${table.name}" SET ${col} = ${appended} WHERE ${where};\n`);
    }
  });
  return { statements };
}

/** Quote a value as a SQLite literal. */
export function toSqliteLiteral(value: unknown, type: string): string {
  if (value === null || value === undefined) return 'NULL';

  switch (type) {
    case 'Boolean':
      return value ? '1' : '0';
    case 'Int':
    case 'Float': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? String(n) : 'NULL';
    }
    case 'BigInt':
    case 'Decimal': {
      // delivered as text by the select list; keep full precision
      const s = String(value);
      return /^-?\d+(\.\d+)?$/.test(s) ? s : quote(s);
    }
    case 'Bytes':
      return `X'${Buffer.from(value as Uint8Array).toString('hex')}'`;
    case 'Json':
      return quote(typeof value === 'string' ? value : JSON.stringify(value));
    default:
      return quote(String(value));
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Postgres select expression that yields the value in D1 form. */
function selectExpression({ name, type }: Column): string {
  const col = `"${name}"`;
  switch (type) {
    case 'DateTime':
      return `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"+00:00"') as ${col}`;
    case 'Json':
    case 'Decimal':
    case 'BigInt':
      return `${col}::text as ${col}`;
    default:
      return col;
  }
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    source: process.env.SOURCE_DATABASE_URL ?? '',
    out: path.join(ROOT, '.wrangler/migration'),
    exclude: [],
    rowsPerStatement: 500,
    maxFileBytes: 100 * 1024 * 1024,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--source':
        opts.source = next();
        break;
      case '--out':
        opts.out = path.resolve(next());
        break;
      case '--tables':
        opts.tables = next().split(',').filter(Boolean);
        break;
      case '--exclude':
        opts.exclude = next().split(',').filter(Boolean);
        break;
      case '--rows-per-statement':
        opts.rowsPerStatement = Number(next());
        break;
      case '--max-file-mb':
        opts.maxFileBytes = Number(next()) * 1024 * 1024;
        break;
      case '--help':
      case '-h':
        console.log(readFileSync(import.meta.filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!opts.source) {
    throw new Error('Provide the Postgres URL with --source or SOURCE_DATABASE_URL');
  }

  return opts;
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? `${u.username}@` : ''}${u.host}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

class SqlFileWriter {
  private stream: WriteStream | null = null;
  private bytes = 0;
  private part = 0;
  readonly files: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly index: number,
    private readonly table: string,
    private readonly maxBytes: number,
  ) {}

  async write(statement: string) {
    return this.writeGroup([statement]);
  }

  /** Write statements that must land in the same file (a row and its appends). */
  async writeGroup(statements: string[]) {
    const size = statements.reduce((n, s) => n + Buffer.byteLength(s), 0);
    if (!this.stream || (this.bytes > 0 && this.bytes + size > this.maxBytes)) {
      await this.rotate();
    }
    const stream = this.stream as WriteStream;
    this.bytes += size;
    for (const statement of statements) {
      if (!stream.write(statement)) {
        await new Promise<void>(resolve => stream.once('drain', () => resolve()));
      }
    }
  }

  private async rotate() {
    await this.close();
    this.part++;
    const file = `${String(this.index).padStart(4, '0')}_${this.table}_${String(this.part).padStart(3, '0')}.sql`;
    this.files.push(file);
    this.stream = createWriteStream(path.join(this.dir, file));
    this.bytes = 0;
  }

  async close() {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve, reject) =>
      s.end((err?: Error) => (err ? reject(err) : resolve())),
    );
  }
}

async function exportTable(
  client: Client,
  table: Table,
  index: number,
  opts: Options,
): Promise<{ rows: number; files: string[] }> {
  const existing = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1`,
    [table.name],
  );
  const present = new Set(existing.rows.map(r => r.column_name));
  if (!present.size) {
    console.log(`  ${table.name}: not present in source, skipped`);
    return { rows: 0, files: [] };
  }

  const columns = table.columns.filter(c => present.has(c.name));
  const missing = table.columns.filter(c => !present.has(c.name)).map(c => c.name);
  if (missing.length) {
    console.log(`  ${table.name}: source lacks ${missing.join(', ')} (D1 defaults apply)`);
  }

  const { rows: countRows } = await client.query<{ n: string }>(
    `select count(*)::text as n from "${table.name}"`,
  );
  const total = Number(countRows[0].n);
  if (!total) {
    console.log(`  ${table.name}: 0 rows`);
    return { rows: 0, files: [] };
  }

  const writer = new SqlFileWriter(opts.out, index, table.name, opts.maxFileBytes);
  const header = `INSERT OR REPLACE INTO "${table.name}" (${columns.map(c => `"${c.name}"`).join(', ')}) VALUES\n`;
  let batch: string[] = [];
  let batchBytes = 0;
  let exported = 0;
  let wide = 0;

  const headerBytes = Buffer.byteLength(header);
  batchBytes = headerBytes;
  const flush = async () => {
    if (!batch.length) return;
    await writer.write(`${header}${batch.join(',\n')};\n`);
    batch = [];
    batchBytes = headerBytes;
  };

  await client.query('BEGIN');
  await client.query(
    `DECLARE umami_export NO SCROLL CURSOR FOR select ${columns.map(selectExpression).join(', ')} from "${table.name}"`,
  );

  for (;;) {
    const { rows } = await client.query({
      text: `FETCH ${FETCH_SIZE} FROM umami_export`,
      rowMode: 'array',
    });
    if (!rows.length) break;

    for (const row of rows as unknown[][]) {
      const result = rowStatements(table, columns, row, header);
      if ('statements' in result) {
        await flush();
        await writer.writeGroup(result.statements);
        wide++;
        exported++;
        continue;
      }
      const { tuple } = result;
      const tupleBytes = Buffer.byteLength(tuple);
      if (batch.length >= opts.rowsPerStatement || batchBytes + tupleBytes > MAX_STATEMENT_BYTES) {
        await flush();
      }
      batch.push(tuple);
      batchBytes += tupleBytes + 2;
      exported++;
    }

    if (process.stdout.isTTY) process.stdout.write(`\r  ${table.name}: ${exported}/${total}`);
  }

  await flush();
  await client.query('CLOSE umami_export');
  await client.query('COMMIT');
  await writer.close();
  process.stdout.write(
    `${process.stdout.isTTY ? '\r' : ''}  ${table.name}: ${exported}/${total} rows -> ${writer.files.length} file(s)${
      wide ? ` (${wide} wide row(s) written in slices)` : ''
    }\n`,
  );

  return { rows: exported, files: writer.files };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const schema = parsePrismaSchema(readFileSync(SCHEMA_PATH, 'utf8'));

  let tables = schema;
  if (opts.tables) {
    const wanted = new Set(opts.tables);
    const unknown = opts.tables.filter(t => !schema.some(s => s.name === t));
    if (unknown.length) throw new Error(`Unknown table(s): ${unknown.join(', ')}`);
    tables = schema.filter(t => wanted.has(t.name));
  }
  tables = tables.filter(t => !opts.exclude.includes(t.name));

  if (existsSync(opts.out)) rmSync(opts.out, { recursive: true });
  mkdirSync(opts.out, { recursive: true });

  const client = new Client({ connectionString: opts.source });
  // keep numerics/bigints/json as text so nothing loses precision on the way
  types.setTypeParser(types.builtins.NUMERIC, v => v);
  types.setTypeParser(types.builtins.INT8, v => v);
  types.setTypeParser(types.builtins.JSON, v => v);
  types.setTypeParser(types.builtins.JSONB, v => v);
  await client.connect();
  await client.query(`SET TIME ZONE 'UTC'`);

  const { rows: sizeRows } = await client.query<{ bytes: string }>(
    'select pg_database_size(current_database())::text as bytes',
  );
  const sizeGb = Number(sizeRows[0].bytes) / 1024 ** 3;
  console.log(`Source ${redact(opts.source)} (${sizeGb.toFixed(2)} GB on disk)`);
  if (sizeGb > 10) {
    console.log(
      '  WARNING: Cloudflare D1 databases are limited to 10 GB. Consider --exclude for large tables such as session_replay or heatmap_event.',
    );
  }
  console.log(`Writing ${tables.length} table(s) to ${opts.out}`);

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    source: redact(opts.source),
    tables: [],
    files: [],
  };

  try {
    let index = 0;
    for (const table of tables) {
      index++;
      const { rows, files } = await exportTable(client, table, index, opts);
      manifest.tables.push({ name: table.name, rows, files });
      manifest.files.push(...files);
    }
  } finally {
    await client.end();
  }

  const manifestPath = path.join(opts.out, 'manifest.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const totalRows = manifest.tables.reduce((n, t) => n + t.rows, 0);
  console.log(
    `\nExported ${totalRows} rows in ${manifest.files.length} file(s). Manifest: ${manifestPath}`,
  );
  console.log('\nNext: apply the D1 schema and import:');
  console.log('  pnpm cf:migrate:remote');
  const rel = path.relative(ROOT, opts.out);
  const dirArg = rel && !rel.startsWith('..') ? rel : opts.out;
  console.log(`  pnpm cf:migrate:import --remote --dir ${dirArg} --verify`);
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isCli) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
