// MaxMind lookups are replaced by Cloudflare's request geolocation (cf-ipcountry,
// cf-ipcity, cf-region-code headers injected by src/cloudflare/worker.ts).
export type CityResponse = Record<string, never>;
export type Reader<T = unknown> = { get: (ip: string) => T | null };

async function open<T = unknown>(): Promise<Reader<T>> {
  return { get: () => null };
}

export default { open };
export { open };
