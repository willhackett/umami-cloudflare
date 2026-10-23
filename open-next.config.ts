import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// umami renders everything dynamically, so no incremental cache / queue is needed.
const config = defineCloudflareConfig({});

// Upstream's `build` script regenerates the Postgres Prisma client and checks the
// Postgres connection; the Cloudflare pipeline (pnpm cf:build) already did the
// Cloudflare-specific preparation, so OpenNext only needs `next build` here.
config.buildCommand = process.env.CF_NEXT_BUILD_COMMAND ?? 'pnpm cf:build:next';

export default config;
