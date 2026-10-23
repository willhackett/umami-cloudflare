// ClickHouse is not part of the Cloudflare stack. umami only calls createClient()
// when CLICKHOUSE_URL is set, so this stub keeps the Node-only driver out of the bundle.
export type ClickHouseClient = never;

export function createClient(): never {
  throw new Error(
    '[umami-cloudflare] ClickHouse is not supported on Cloudflare. Unset CLICKHOUSE_URL.',
  );
}
