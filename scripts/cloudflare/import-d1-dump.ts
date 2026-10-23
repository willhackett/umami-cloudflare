/**
 * Load the SQL files produced by pg-to-d1.ts (`pnpm cf:migrate:export`) into a
 * Cloudflare D1 database through wrangler, in manifest order, then optionally
 * compare row counts.
 *
 *   pnpm cf:migrate:import --remote|--local [--dir .wrangler/migration] [--database umami]
 *                           [--verify] [--verify-only] [--from 0012_website_event_003.sql]
 *
 * The D1 schema must already be applied (`pnpm cf:migrate:remote` / `cf:migrate:local`).
 * Files are idempotent (INSERT OR REPLACE), so an interrupted import can be resumed
 * with --from <file>.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Manifest } from './pg-to-d1.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

interface Options {
  dir: string;
  database: string;
  remote: boolean;
  verify: boolean;
  verifyOnly: boolean;
  from?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dir: path.join(ROOT, '.wrangler/migration'),
    database: 'umami',
    remote: false,
    verify: false,
    verifyOnly: false,
  };
  let target: 'remote' | 'local' | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--remote':
        target = 'remote';
        break;
      case '--local':
        target = 'local';
        break;
      case '--dir':
        opts.dir = path.resolve(next());
        break;
      case '--database':
        opts.database = next();
        break;
      case '--verify':
        opts.verify = true;
        break;
      case '--verify-only':
        opts.verify = true;
        opts.verifyOnly = true;
        break;
      case '--from':
        opts.from = next();
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

  if (!target) throw new Error('Pass --remote (Cloudflare) or --local (wrangler dev state)');
  opts.remote = target === 'remote';
  return opts;
}

function wrangler(opts: Options, args: string[], capture = false) {
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      opts.database,
      opts.remote ? '--remote' : '--local',
      ...args,
    ],
    { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    if (capture) process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    throw new Error(`wrangler d1 execute failed (exit ${result.status})`);
  }
  return result.stdout ?? '';
}

function verify(opts: Options, manifest: Manifest) {
  const tables = manifest.tables.filter(t => t.rows > 0);
  if (!tables.length) return true;

  // one statement per table: D1 limits the number of terms in a compound SELECT
  const counts = new Map<string, number>();
  for (const t of tables) {
    const stdout = wrangler(
      opts,
      ['--json', '--command', `select count(*) as c from "${t.name}"`],
      true,
    );
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('['))) as { results: { c: number }[] }[];
    counts.set(t.name, Number(parsed[0].results[0].c));
  }

  let ok = true;
  console.log('\nRow counts (source -> D1):');
  for (const t of tables) {
    const got = counts.get(t.name) ?? 0;
    const flag = got >= t.rows ? 'ok' : 'MISSING ROWS';
    if (got < t.rows) ok = false;
    console.log(
      `  ${t.name.padEnd(26)} ${String(t.rows).padStart(10)} -> ${String(got).padStart(10)}  ${flag}`,
    );
  }
  return ok;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(opts.dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json in ${opts.dir}; run pnpm cf:migrate:export first`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  if (!opts.verifyOnly) {
    let files = manifest.files;
    if (opts.from) {
      const idx = files.indexOf(opts.from);
      if (idx === -1) throw new Error(`${opts.from} is not in the manifest`);
      files = files.slice(idx);
    }

    console.log(
      `Importing ${files.length} file(s) from ${manifest.source} into D1 "${opts.database}" (${opts.remote ? 'remote' : 'local'})`,
    );
    for (const [i, file] of files.entries()) {
      console.log(`\n[${i + 1}/${files.length}] ${file}`);
      wrangler(opts, ['--file', path.join(opts.dir, file), '--yes']);
    }
  }

  if (opts.verify) {
    const ok = verify(opts, manifest);
    if (!ok) {
      console.error('\nSome tables have fewer rows than the source. Re-run the import for them.');
      process.exit(2);
    }
    console.log('\nAll tables match.');
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
