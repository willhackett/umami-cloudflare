// Prisma CLI config for the Cloudflare (D1 / SQLite) build.
// Usage: prisma <cmd> --config prisma.cloudflare.config.ts
// The datasource URL is a placeholder: migrations are produced by `prisma migrate diff`
// (schema-to-schema, no database needed) and applied with `wrangler d1 migrations apply`.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.sqlite.prisma',
  datasource: {
    url: 'file:./.wrangler/prisma-placeholder.db',
  },
  migrations: {
    path: 'prisma/migrations-d1',
  },
});
