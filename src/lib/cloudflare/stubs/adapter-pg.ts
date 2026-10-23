// Postgres is not part of the Cloudflare stack; D1 is used instead (src/lib/cloudflare/d1.ts).
export class PrismaPg {
  constructor() {
    throw new Error(
      '[umami-cloudflare] Postgres is not supported on Cloudflare. Set DATABASE_URL=d1://DB.',
    );
  }
}
