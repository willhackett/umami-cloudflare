<p align="center">
  <img src="https://content.umami.is/website/images/umami-logo.png" alt="Umami Logo" width="100">
</p>

<h1 align="center">umami-cloudflare</h1>

<p align="center">
  <i><a href="https://umami.is">Umami</a>, the privacy-first analytics platform, running entirely on Cloudflare Workers, D1 and KV. No servers, no Postgres, no ClickHouse.</i>
</p>

<p align="center">
  <a href="https://github.com/umami-software/umami/blob/master/LICENSE"><img src="https://img.shields.io/github/license/umami-software/umami.svg" alt="MIT License" /></a>
  <a href="https://github.com/umami-software/umami/releases"><img src="https://img.shields.io/badge/upstream-umami%20v3.4.0-blue" alt="Based on umami v3.4.0" /></a>
</p>

---

## Credits

This project is a fork of **[Umami](https://github.com/umami-software/umami)** by
[Umami Software, Inc.](https://umami.is) Umami is a simple, fast, privacy-focused alternative
to Google Analytics: traffic, campaigns, behaviour, conversions and revenue, with no cookies
and no surveillance. All of the product, the dashboard, the tracker, the reports and the
data model are theirs, released under the [MIT License](LICENSE).

This fork only changes *where it runs*. If you can use Umami on a server or on
[Umami Cloud](https://cloud.umami.is), please do, and consider
[supporting the project](https://umami.is). Bugs in the analytics itself belong
[upstream](https://github.com/umami-software/umami/issues); bugs in the Cloudflare port
belong here.

## What this fork does

| Umami needs        | Cloudflare service                                                  |
| ------------------ | ------------------------------------------------------------------- |
| Next.js app server | **Workers** via [OpenNext](https://opennext.js.org/cloudflare)      |
| SQL database       | **D1** (SQLite) through Prisma's D1 adapter                         |
| Static assets      | **Workers Static Assets**                                           |
| Cache (optional)   | **Workers KV** (replaces Redis)                                     |
| GeoIP              | **Cloudflare request geolocation** (replaces MaxMind)               |

Everything upstream ships still works: dashboards, reports, funnels, journeys, retention,
attribution, heatmaps, session replay, revenue, event data, teams, share links, API keys,
two-factor auth and the MCP endpoint. Upstream's Postgres SQL is translated to SQLite at
runtime, so upstream's query files are untouched and future Umami releases merge cleanly.
How that works, and what the limits are, is in
[docs/cloudflare/CONVERSION.md](docs/cloudflare/CONVERSION.md) and
[docs/cloudflare/README.md](docs/cloudflare/README.md).

## Deploy to Cloudflare

### Requirements

- Node.js 22 and pnpm 12.
- A Cloudflare account. The free plan works for small sites. Workers Paid is recommended
  for anything real: on the free plan D1 is capped at 500 MB and 50 queries per request,
  which some reports exceed.
- Cloudflare's CLI, `wrangler`, is installed with the project dependencies.

### 1. Get the code and log in

```bash
git clone https://github.com/willhackett/umami-cloudflare.git
cd umami-cloudflare
pnpm install
pnpm exec wrangler login
```

### 2. Create the database

```bash
pnpm exec wrangler d1 create umami
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing the zero UUID under
`d1_databases`.

### 3. Set the app secret

`APP_SECRET` signs login sessions and share tokens. Make it long and random.

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put APP_SECRET
```

Optional secrets, set the same way: `TWO_FACTOR_ENCRYPTION_KEY` (64 hex characters,
enables two-factor auth) and `MCP_ENABLED=1` as a plain var if you want the `/mcp`
endpoint.

### 4. Build, migrate and deploy

```bash
pnpm cf:deploy
```

This generates the SQLite Prisma schema and client, builds the tracker and session
recorder, builds the Next.js app with OpenNext, applies the D1 migrations to your remote
database and deploys the Worker. The command prints the Worker URL at the end.

Log in at that URL with **admin** / **umami** and change the password immediately.

### 5. Add a website

In the dashboard, add your website and copy the tracking snippet. It points at your
Worker URL, for example:

```html
<script defer src="https://umami.<your-subdomain>.workers.dev/script.js" data-website-id="..."></script>
```

### Optional

- **Custom domain**: add a `routes` entry with `custom_domain: true` to `wrangler.jsonc`,
  or attach a domain in the Cloudflare dashboard under the Worker's settings. Redeploy
  afterwards.
- **KV cache**: `pnpm exec wrangler kv namespace create CACHE`, then uncomment
  `kv_namespaces` in `wrangler.jsonc` with the printed id. This replaces Redis for
  website and session lookups. KV is eventually consistent, so only enable it if a
  delay of up to a minute on new websites and logins is acceptable.
- **Environment variables**: all of Umami's variables (`BASE_PATH`,
  `TRACKER_SCRIPT_NAME`, `COLLECT_API_ENDPOINT`, `DISABLE_BOT_CHECK`, `IGNORE_IP`,
  `REMOVE_TRAILING_SLASH`, and so on) go under `vars` in `wrangler.jsonc`. The full
  table is in [docs/cloudflare/README.md](docs/cloudflare/README.md#environment-variables).
- **Deploy from GitHub Actions**: add the repository secrets `CLOUDFLARE_API_TOKEN`
  (Workers Scripts:Edit, D1:Edit, Workers KV:Edit, Account Settings:Read) and
  `CLOUDFLARE_ACCOUNT_ID`, then run the **Deploy to Cloudflare** workflow. Set
  `APP_SECRET` once with `wrangler secret put` first.

## Migrating from an existing Umami installation

Move your Postgres data into D1 in three commands. Upgrade the source Umami to the
version this fork is based on first, so the schemas line up.

```bash
pnpm cf:migrate:export --source postgresql://user:pass@host:5432/umami --out .wrangler/migration
pnpm cf:migrate:remote
pnpm cf:migrate:import --remote --dir .wrangler/migration --verify
```

The export derives the table list from the generated SQLite schema, streams rows out of
Postgres and converts timestamps, booleans, decimals and JSON. The import loads the files
through `wrangler` and compares per-table row counts. Statements are `INSERT OR REPLACE`,
so re-running is safe. Website ids and the tracker script are unchanged, so existing
embeds keep working once you switch the script URL to the Worker.

D1 databases are limited to 10 GB. The export prints the source size and warns above
that limit. Use `--exclude session_replay,heatmap_event` to leave out bulky tables. See
[docs/cloudflare/README.md](docs/cloudflare/README.md#migrating-an-existing-umami-installation)
for the details.

## Updating

```bash
git pull
pnpm install
pnpm cf:deploy
```

New D1 migrations are applied as part of the deploy.

## Local development

```bash
cp .env.cloudflare.example .env
pnpm cf:dev        # next dev against a local D1, migrations applied automatically
pnpm cf:preview    # the real OpenNext build running in workerd
pnpm cf:test       # translator unit tests + every query executed against local D1
```

## Keeping up with upstream

`pnpm cf:sync` fetches and merges `umami-software/umami`, regenerates the SQLite schema
and creates a D1 migration if the schema moved. The conversion lives in
`src/lib/cloudflare/`, `src/cloudflare/`, `scripts/cloudflare/` and `prisma/migrations-d1/`,
with a handful of marked hooks in upstream files. The full list and the merge checklist
are in [docs/cloudflare/CONVERSION.md](docs/cloudflare/CONVERSION.md).

## Limits

The things that differ from Umami on Postgres, in short:

- D1: 10 GB per database, single-threaded, roughly 1,000 simple queries per second.
- Contains and search filters are ASCII case-insensitive rather than Unicode.
- Regex filters are compiled to SQLite `GLOB`. Anchors, classes, groups, alternation and
  bounded repetition work. Lookaround and back-references do not.
- Timezone handling uses an offset table generated at build time, exact from 2015 to two
  years ahead.
- ClickHouse, Kafka, Redis, Postgres read replicas and Docker are not supported.

The full list with reasons is in
[docs/cloudflare/README.md](docs/cloudflare/README.md#limits-and-differences).

## License

MIT, the same as Umami. See [LICENSE](LICENSE).
