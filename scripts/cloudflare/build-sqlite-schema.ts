/* eslint-disable no-console */
/**
 * Derives prisma/schema.sqlite.prisma from upstream's prisma/schema.prisma.
 *
 * Upstream owns schema.prisma (PostgreSQL). We never edit it; instead this script
 * rewrites it mechanically for SQLite/D1 so that upstream schema changes flow
 * through `pnpm cf:schema` after every merge.
 *
 * Transformations:
 *  - datasource provider postgresql -> sqlite
 *  - generator: runtime = "cloudflare" (workerd-compatible client)
 *  - strip Postgres native type attributes (@db.Uuid, @db.VarChar(n), @db.Timestamptz(6), ...)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const source = path.join(root, 'prisma/schema.prisma');
const target = path.join(root, 'prisma/schema.sqlite.prisma');

const input = fs.readFileSync(source, 'utf8');

let output = input;

output = output.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"');

// Prisma Client for workerd: no Node-only runtime code.
output = output.replace(/(generator\s+client\s*\{[^}]*?)(\n\})/, (_, body: string, end: string) => {
  if (/runtime\s*=/.test(body)) return `${body}${end}`;
  return `${body}\n  runtime    = "cloudflare"${end}`;
});

// Native type attributes are Postgres-only.
output = output.replace(/\s*@db\.\w+(\([^)]*\))?/g, '');

// Collapse runs of spaces left behind so the file stays tidy.
output = output
  .split('\n')
  .map(line => line.replace(/\s+$/, ''))
  .join('\n');

const header = `// GENERATED FILE - do not edit.
// Derived from prisma/schema.prisma by scripts/cloudflare/build-sqlite-schema.ts
// Regenerate with: pnpm cf:schema
`;

output = `${header}\n${output}`;

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (existing !== output) {
    console.error('prisma/schema.sqlite.prisma is out of date. Run `pnpm cf:schema`.');
    process.exit(1);
  }
  console.log('prisma/schema.sqlite.prisma is up to date.');
  process.exit(0);
}

fs.writeFileSync(target, output);
console.log(`Wrote ${path.relative(root, target)}`);
