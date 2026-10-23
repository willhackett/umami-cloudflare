# umami on Cloudflare

This fork runs [umami](https://github.com/umami-software/umami) entirely on Cloudflare's
stack, with no servers, containers, Postgres, Redis or ClickHouse:

| umami needs          | Cloudflare service                                  |
| -------------------- | --------------------------------------------------- |
| Next.js app server   | **Workers** (via [OpenNext](https://opennext.js.org/cloudflare)) |
| SQL database         | **D1** (SQLite), through Prisma's D1 adapter        |
| Static assets        | **Workers Static Assets**                           |
| Cache (optional)     | **Workers KV**                                      |
| GeoIP                | **Cloudflare request geolocation** (`request.cf`)   |

Everything upstream still works (dashboards, reports, event data, session replay,
heatmaps, 2FA, API keys, teams, share links...). The Postgres SQL that upstream ships is
translated to SQLite at runtime; see [CONVERSION.md](./CONVERSION.md) for how.

## Deploy

Requirements: Node 22, pnpm 12, a Cloudflare account (Workers Paid is recommended; D1
on the free plan caps at 500 MB and 50 queries per Worker invocation).

```bash
pnpm install

# 1. Create the database and put its id in wrangler.jsonc (d1_databases[0].database_id)
pnpm exec wrangler d1 create umami

# 2. Secrets (APP_SECRET signs sessions/tokens; make it long and random)
pnpm exec wrangler secret put APP_SECRET

# 3. Build, migrate, deploy
pnpm cf:deploy
```

`pnpm cf:deploy` runs the full pipeline: generate the SQLite Prisma schema and client,
build the tracker/recorder scripts, build the Next.js app with OpenNext, apply D1
migrations remotely and deploy the Worker. The first login is `admin` / `umami`
(umami seeds it on first start).

Optional:

- **KV cache**: create a namespace (`wrangler kv namespace create CACHE`) and uncomment
  `kv_namespaces` in `wrangler.jsonc`. umami then caches website/session lookups and
  stores login sessions in KV instead of signing them into the token. KV is eventually
  consistent (writes can take up to ~60 s to become visible in other locations), so
  only enable it if that trade-off is acceptable for your users.
- **Custom domain**: add a `routes`/`custom_domain` entry to `wrangler.jsonc` as usual.
- **GitHub Actions**: `.github/workflows/cloudflare-deploy.yml` deploys on manual
  dispatch using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.

### Environment variables

Set plain variables under `vars` in `wrangler.jsonc` and secrets with `wrangler secret put`.
All of upstream's variables (`BASE_PATH`, `TRACKER_SCRIPT_NAME`, `COLLECT_API_ENDPOINT`,
`DISABLE_BOT_CHECK`, `IGNORE_IP`, `REMOVE_TRAILING_SLASH`, ...) are honoured. Cloudflare
specific ones:

| Variable          | Value                        | Notes                                                       |
| ----------------- | ---------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`    | `d1://DB`                    | `d1://<binding>` selects the D1 binding (default `DB`).     |
| `APP_SECRET`      | random string (secret)       | Required: upstream derives it from `DATABASE_URL` otherwise. |
| `SKIP_DB_CHECK`   | `1`                          | Upstream's Postgres version check does not apply.           |
| `DISABLE_TELEMETRY` | `1`                        | Optional.                                                   |

`CLICKHOUSE_URL`, `KAFKA_URL` and `REDIS_URL` must stay unset.

## Local development

```bash
cp .env.cloudflare.example .env
pnpm cf:dev          # next dev with a local D1 (migrations applied automatically)
pnpm cf:preview      # full OpenNext build running in workerd (what production runs)
pnpm cf:test         # translator unit tests + every query executed against local D1
```

`pnpm cf:dev` uses `initOpenNextCloudflareForDev()` so the Next.js dev server sees the
same bindings as the Worker, persisted under `.wrangler/state`.

## Scripts

| Script                  | What it does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| `cf:schema`             | Regenerate `prisma/schema.sqlite.prisma` from upstream's schema    |
| `cf:db:generate`        | Generate the Prisma client for D1 (`runtime = "cloudflare"`)       |
| `cf:migrate:diff <name>`| Create a D1 migration from the schema change since the last commit |
| `cf:migrate:local`/`remote` | Apply `prisma/migrations-d1/*.sql` with wrangler               |
| `cf:build`              | Everything needed to produce `.open-next/`                         |
| `cf:deploy` / `cf:upload` | Build + migrate + deploy (or upload a version)                   |
| `cf:sync`               | Merge upstream and re-run the conversion steps                     |

## Limits and differences

- **D1 limits**: 10 GB per database, 100 bound parameters and 100 KB per statement,
  30 s per query. Very large filter lists (more than ~90 values) are rejected with a
  clear error. Percentile reports aggregate values into a JSON array per group, which
  is fine for the data volumes D1 is meant for but is not a ClickHouse replacement.
- **Regex filters** (`~*`) are supported only when the pattern can be expressed as a
  SQL `LIKE` (`^`, `$`, `.`, `.*`, escaped literals). Other patterns return an error;
  use *contains* instead.
- **Timezones** are computed from an offset table generated with `Intl` (2015 to two
  years ahead) instead of the database's tz data; results are exact within that window.
- **Heatmap page sizes** use `max()` instead of Postgres' `mode()` per visit.
- **Transactions**: D1 has no interactive transactions. umami's only interactive
  transaction (2FA rate limiting) runs as sequential statements.
- **GeoIP**: country/region/city come from Cloudflare's own geolocation, no MaxMind
  download. `cf-ipcity`/`cf-region-code` are injected by `src/cloudflare/worker.ts`.
- **Not supported**: ClickHouse, Kafka, Redis, Postgres (replicas, schemas), the MCP
  package's server mode, `next start`/Docker.
