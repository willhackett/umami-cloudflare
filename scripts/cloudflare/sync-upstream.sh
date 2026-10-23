#!/usr/bin/env bash
# Pull the latest upstream umami and re-run the Cloudflare conversion steps.
#
#   scripts/cloudflare/sync-upstream.sh [upstream-ref]   (default: upstream/master)
#
# What it does:
#   1. git fetch upstream && git merge <ref>
#   2. pnpm install (lockfile may have changed)
#   3. regenerate prisma/schema.sqlite.prisma and a D1 migration if the schema moved
#   4. print the checklist in docs/cloudflare/CONVERSION.md
set -euo pipefail

REF="${1:-upstream/master}"
cd "$(dirname "$0")/../.."

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/umami-software/umami.git
fi

git fetch upstream

if ! git merge --no-edit "$REF"; then
  echo
  echo "Merge has conflicts. Files owned by the Cloudflare conversion are listed in docs/cloudflare/CONVERSION.md."
  echo "Resolve, then run: pnpm cf:schema && pnpm cf:migrate:diff upstream_sync"
  exit 1
fi

pnpm install
pnpm cf:schema

if ! git diff --quiet -- prisma/schema.sqlite.prisma; then
  echo "Schema changed upstream; generating D1 migration..."
  pnpm cf:migrate:diff upstream_sync
fi

echo
echo "Upstream merged. Next steps:"
echo "  - review 'git diff HEAD~1 -- src/lib/db.ts src/lib/prisma.ts next.config.ts tsconfig.json package.json' for hook drift"
echo "  - push and let CI build/test against local D1"
echo "  - see docs/cloudflare/CONVERSION.md"
