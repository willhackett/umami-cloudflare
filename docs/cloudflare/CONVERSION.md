# How the Cloudflare conversion works (and how to keep merging upstream)

The guiding rule of this fork: **upstream files are hooks, not forks.** Every
Cloudflare-specific behaviour lives in new files; upstream files are touched only at a
handful of small, clearly-marked seams. That keeps `git merge upstream/master` cheap.

## Files owned by the conversion

New files (never conflict with upstream):

```
src/lib/cloudflare/
  env.ts                 # access to bindings (getCloudflareContext / test injection)
  d1.ts                  # lazy PrismaClient on @prisma/adapter-d1 + raw query execution
  redis.ts               # KV-backed drop-in for src/lib/redis.ts (same API)
  sql/translate.ts       # Postgres -> SQLite SQL translation (the heart of the port)
  sql/timezone.ts        # Intl-based offset tables for `at time zone`
  sql/translate.test.ts
  stubs/*.ts             # @clickhouse/client, kafkajs, maxmind, redis, @prisma/adapter-pg, is-localhost-ip
src/cloudflare/worker.ts # Worker entry: wraps OpenNext handler, injects geo headers
scripts/cloudflare/      # schema derivation, D1 migration diff, upstream sync, Postgres -> D1 export/import
prisma/schema.sqlite.prisma   # GENERATED from prisma/schema.prisma (pnpm cf:schema)
prisma/migrations-d1/         # D1 migrations (wrangler format)
prisma.cloudflare.config.ts
wrangler.jsonc, open-next.config.ts, vitest.cloudflare.config.ts
tests/cloudflare/        # D1 integration test running every query; queries over migrated data
.github/workflows/cloudflare*.yml
docs/cloudflare/
```

Upstream files with hooks (search for `umami-cloudflare` comments):

| File                | Change                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `src/lib/db.ts`     | `D1` database type, `isD1()`, `runQuery` and `isRelationalOnly` accept D1               |
| `src/lib/prisma.ts` | `getClient()` returns the lazy D1 client; `executeRawQuery()` delegates to `runD1RawQuery` |
| `next.config.ts`    | `turbopack.resolveAlias` for the stubs + KV cache; `serverExternalPackages`; `initOpenNextCloudflareForDev()` |
| `tsconfig.json`     | `paths` entry mapping `@/lib/redis` to the KV module                                     |
| `package.json`      | `cf:*` scripts and the Cloudflare dependencies                                           |
| `pnpm-workspace.yaml` | allow the `workerd` postinstall                                                        |
| `.gitignore`        | `.open-next`, `.wrangler`, `.dev.vars`, `cloudflare-env.d.ts`                            |
| `README.md`         | pointer to this documentation                                                            |

Nothing under `src/queries/`, `src/app/`, `src/components/` or `prisma/schema.prisma`
is modified.

## How each upstream dependency is replaced

### Database: Prisma + D1

- `DATABASE_URL=d1://DB` makes `getDatabaseType()` return `d1`. `runQuery()` then uses
  the `[PRISMA]` branch of every query, exactly like Postgres.
- `src/lib/cloudflare/d1.ts` builds `new PrismaClient({ adapter: new PrismaD1(env.DB) })`
  lazily on first use (bindings only exist inside a request) and caches it on
  `globalThis`. Interactive `$transaction(fn)` calls run the callback against the plain
  client because D1 has no transactions; batch transactions map to D1 batch.
- The Prisma schema is derived, not forked: `scripts/cloudflare/build-sqlite-schema.ts`
  rewrites `provider`, adds `runtime = "cloudflare"` and strips `@db.*` native types.
  `pnpm cf:schema:check` fails CI if the generated file is stale.
- Migrations are produced with `prisma migrate diff` between the last committed
  `schema.sqlite.prisma` and the current one (`pnpm cf:migrate:diff <name>`), and
  applied with `wrangler d1 migrations apply`. `DEFAULT CURRENT_TIMESTAMP` is rewritten
  to the ISO format the D1 adapter uses so raw SQL string comparisons stay consistent.

### Raw SQL: the translator

Upstream's ~80 relational queries are PostgreSQL strings with `{{param}}` placeholders.
`executeRawQuery()` in `src/lib/prisma.ts` hands them to `runD1RawQuery()`, which runs
`translateQuery()` and executes the result with `$queryRawUnsafe`. The translator is a
sequence of small passes, each handling one Postgres construct upstream uses:

| Postgres                                            | SQLite                                                         |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `{{p}}`, `{{p::uuid}}`, `$1`                         | `?` positional binding; arrays bound as one JSON parameter     |
| `= ANY({{p}})`, `!= ALL({{p}})`                      | `in (select value from json_each(?))`, `not in (...)`          |
| `col ilike {{p}}` with a `%text%` value              | `instr(lower(col), ?) > 0` (no 50-byte pattern limit); else `like` |
| `col ~* {{p}}`, `col !~* {{p}}`                      | `(lower(col) glob ? or ...)`: regex compiled to GLOB patterns  |
| `x::int`, `::bigint`, `::float`, `::date`, `::uuid`  | `cast(x as integer/real)`, `date(x)`, stripped                 |
| `at time zone 'Z'`                                   | `datetime(unixepoch(x) + <offset case expr>, 'unixepoch')`     |
| `date_trunc('unit', x)`                              | `datetime(x, 'start of day')`, `strftime(...)`                 |
| `to_char(x, 'YYYY-MM-DD"T"HH24:...')`                 | `strftime('%Y-%m-%dT%H:...', x)`                               |
| `extract(epoch/hour/dow from x)`                     | `unixepoch(x, 'subsec')`, `strftime('%H'/'%w', x)`             |
| `x + interval '5 minute'`, `x + n * interval '4 hour'`| `strftime(<canonical>, x, '+5 minutes')`                       |
| `now()`                                              | `strftime(<canonical>, 'now')`                                 |
| `a::date - b::date`                                  | `cast(julianday(a) - julianday(b) as integer)`                 |
| `jsonb_array_elements_text(x::jsonb) as t(value)`    | `json_each(x) as t` (guarded with `json_valid`)                |
| `array_agg(x order by k)`                            | `json_group_array(x order by k)` + JSON.parse on the result    |
| `percentile_cont(p) within group (order by x)`       | interpolation over `json_group_array(x order by x)`            |
| `mode() within group (order by x)`                   | `(select value from json_each(json_group_array(x)) ... order by count(*) desc limit 1)` |
| `bool_or(x)`                                         | `max(x)`                                                       |
| `regexp_replace(h, '^www.', '')`                     | `case when h like 'www_%' then substr(h, 5) else h end`        |
| `select distinct on (k) ... order by k, o`           | `row_number() over (partition by k order by o) = 1`            |
| `group by grouping sets ((a, b), (a))`               | `... group by a, b union all ... group by a`                   |
| `left(x, n)`, `position(a, b)`, `concat(...)`        | `substr(x, 1, n)`, `instr(a, b)`, `coalesce(a,'') || ...`      |

Timestamps are stored the way `@prisma/adapter-d1` writes them
(`YYYY-MM-DDTHH:MM:SS.SSS+00:00`); all generated date expressions and bound `Date`
parameters use that same canonical format so lexical comparisons are correct.

### Cache: KV instead of Redis

`@/lib/redis` is remapped (tsconfig `paths` + turbopack alias) to
`src/lib/cloudflare/redis.ts`, which implements the same `client`/`enabled` API on a KV
namespace bound as `CACHE`. Without the binding `enabled` is `false` and upstream takes
its no-cache code paths, as it does without `REDIS_URL`.

### ClickHouse / Kafka / MaxMind / pg

Upstream imports these modules unconditionally but only instantiates them when their
env vars are set. The bundler aliases the packages to tiny stubs so the Node-only drivers
never reach the Worker bundle. `is-localhost-ip` is also stubbed: it probes addresses by
binding a UDP socket, which never completes in workerd and would hang `/api/send`.

### Next.js on Workers

`@opennextjs/cloudflare` builds the app (`opennextjs-cloudflare build`). Its
`buildCommand` is pinned to `pnpm cf:build:next` (a plain `next build`) because upstream's
`build` script would regenerate the Postgres Prisma client and try to reach Postgres.
`src/cloudflare/worker.ts` wraps the generated handler to add `cf-ipcity` /
`src/cloudflare/worker.ts` wraps the generated handler to add `cf-region-code` headers from `request.cf`, which upstream's `src/lib/detect.ts` already
understands, and refuses to serve until `APP_SECRET` is configured.

### Bundle size

Workers allow 10 MiB (compressed) per script. Turbopack copies the server-side module
graph reachable from `src/lib` into every route group chunk (about 30 copies for umami),
which pushed the bundle to ~11 MiB. Large pure-JS server libraries (`zod`, the Prisma
runtime, `jsonwebtoken`, ...) are therefore listed in `serverExternalPackages` so Next
leaves them to OpenNext, which bundles each once. The result is ~6.3 MiB compressed.
`date-fns` cannot be externalized (Next transpiles it). CI prints the size on every build
(`wrangler deploy --dry-run`); if an upstream merge adds a big server dependency and the
size creeps up, add it to that list.

## Merging upstream

```bash
pnpm cf:sync                 # = git fetch upstream && git merge upstream/master && ...
```

The script merges, reinstalls, regenerates `prisma/schema.sqlite.prisma` and, if the
schema changed, writes a new D1 migration. Then:

1. Resolve conflicts, if any. They can only occur in the hook files listed above.
   Re-apply the hook (each is a few lines marked `umami-cloudflare`).
2. Run `pnpm cf:test`. The integration test executes every relational query against a
   real local D1. A failure means upstream introduced SQL the translator does not handle
   yet: add a pass in `src/lib/cloudflare/sql/translate.ts` and a unit test.
   If upstream added a new query file, add a call to it in `tests/cloudflare/queries.test.ts`.
3. If upstream added a redis method, add it to `src/lib/cloudflare/redis.ts` (TypeScript
   will tell you).
4. If upstream added a Postgres migration, nothing else is needed for data migration:
   `scripts/cloudflare/pg-to-d1.ts` derives its table and column list from the
   generated SQLite schema, so new columns are exported automatically.
5. Push; CI runs the tests, upstream's unit tests, a Postgres -> D1 migration round trip
   against a seeded database, and a full OpenNext build with a dry-run deploy that
   reports the bundle size.

## Design notes

- Translation at runtime (not a one-off rewrite of the query files) is what keeps the
  diff against upstream near zero. The cost is a few hundred microseconds of string
  processing per query, negligible next to a D1 round trip.
- The translator fails loudly (`SqliteTranslateError`) on constructs it does not know
  rather than passing them through, so problems surface in tests, not as wrong numbers.
- Timezone handling precomputes DST transitions per zone with `Intl` into a `CASE`
  expression, which is exact and needs no tz tables in SQLite.
