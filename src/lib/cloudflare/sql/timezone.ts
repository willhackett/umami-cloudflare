/**
 * SQLite has no timezone database, so `x at time zone 'Area/City'` cannot be
 * expressed directly. Instead we precompute every UTC-offset transition for a
 * zone (DST changes) over a wide window and emit a CASE expression that picks
 * the right offset (in seconds) for a given timestamp column. The result is
 * exact for timestamps inside the window and uses the boundary offset outside it.
 *
 * Uses Intl (full ICU is available in Workers and modern Node).
 */

const WINDOW_START_YEAR = 2015;
const WINDOW_YEARS_AHEAD = 2;

interface Transition {
  /** canonical UTC timestamp string (same format the D1 adapter stores) */
  at: string;
  /** offset in seconds that applies from `at` onwards */
  offset: number;
}

interface ZoneInfo {
  base: number;
  transitions: Transition[];
}

const cache = new Map<string, ZoneInfo>();
const formatters = new Map<string, Intl.DateTimeFormat>();

export const CANONICAL_TIMESTAMP_FORMAT = '%Y-%m-%dT%H:%M:%f+00:00';

/** Format a Date the way @prisma/adapter-d1 stores DateTime values. */
export function toCanonicalTimestamp(date: Date): string {
  return date.toISOString().replace('Z', '+00:00');
}

export function isUtcZone(timezone?: string | null): boolean {
  if (!timezone) return true;
  const tz = timezone.trim().toLowerCase();
  return tz === 'utc' || tz === 'etc/utc' || tz === 'gmt' || tz === 'z' || tz === '';
}

function getFormatter(timezone: string) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** UTC offset (seconds) of `timezone` at instant `ms`. */
export function getOffsetSeconds(timezone: string, ms: number): number {
  const parts = getFormatter(timezone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  // asUtc is the wall-clock time interpreted as UTC; the difference is the offset.
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

function findTransition(timezone: string, fromMs: number, toMs: number): number {
  // Binary search the instant where the offset changes (minute precision is enough).
  let lo = fromMs;
  let hi = toMs;
  const start = getOffsetSeconds(timezone, lo);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (getOffsetSeconds(timezone, mid) === start) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Transitions fall on minute boundaries: take the first boundary after `lo`.
  const candidate = Math.ceil(lo / 60_000) * 60_000;
  return candidate > lo ? candidate : candidate + 60_000;
}

export function getZoneInfo(timezone: string): ZoneInfo {
  const cached = cache.get(timezone);
  if (cached) return cached;

  const endYear = new Date().getUTCFullYear() + WINDOW_YEARS_AHEAD;
  const transitions: Transition[] = [];

  let cursor = Date.UTC(WINDOW_START_YEAR, 0, 1);
  const base = getOffsetSeconds(timezone, cursor);
  let current = base;
  const end = Date.UTC(endYear + 1, 0, 1);
  const STEP = 15 * 24 * 3600 * 1000; // 15 days: no zone changes twice within that

  while (cursor < end) {
    const next = Math.min(cursor + STEP, end);
    const offset = getOffsetSeconds(timezone, next);
    if (offset !== current) {
      const at = findTransition(timezone, cursor, next);
      current = getOffsetSeconds(timezone, at);
      transitions.push({ at: toCanonicalTimestamp(new Date(at)), offset: current });
    }
    cursor = next;
  }

  const info = { base, transitions };
  cache.set(timezone, info);
  return info;
}

/**
 * SQL expression (seconds) for the UTC offset of `timezone` at the instant held
 * in `field`. `field` must be a canonical timestamp column/expression.
 */
export function getOffsetSQL(timezone: string, field: string): string {
  const { base, transitions } = getZoneInfo(timezone);

  if (transitions.length === 0) {
    return `${base}`;
  }

  const clauses = transitions.map(t => `when ${field} >= '${t.at}' then ${t.offset}`).reverse();

  return `(case ${clauses.join(' ')} else ${base} end)`;
}

/**
 * SQL expression converting the UTC timestamp in `field` to local wall-clock
 * time in `timezone`, as a SQLite datetime string ('YYYY-MM-DD HH:MM:SS').
 */
export function getLocalTimeSQL(field: string, timezone?: string | null): string {
  if (isUtcZone(timezone)) {
    return `datetime(${field})`;
  }

  return `datetime(unixepoch(${field}) + ${getOffsetSQL(timezone, field)}, 'unixepoch')`;
}
