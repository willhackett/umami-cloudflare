/**
 * Postgres -> SQLite (Cloudflare D1) SQL translation.
 *
 * umami's relational queries are written in PostgreSQL (see src/queries/sql and
 * src/lib/prisma.ts). Instead of forking every query, umami-cloudflare rewrites the
 * Postgres SQL into SQLite at runtime right before execution. Each construct that
 * upstream uses has a dedicated pass below; anything unknown is passed through
 * unchanged so that plain ANSI SQL keeps working.
 *
 * When upstream introduces a new Postgres-only construct, add a pass here and a
 * unit test in translate.test.ts. The integration test (tests/cloudflare) executes
 * every query against a real local D1 database and will surface anything missed.
 */
import { CANONICAL_TIMESTAMP_FORMAT, getLocalTimeSQL, toCanonicalTimestamp } from './timezone';

export class SqliteTranslateError extends Error {
  constructor(message: string) {
    super(`[umami-cloudflare] ${message}`);
    this.name = 'SqliteTranslateError';
  }
}

export interface TranslatedQuery {
  sql: string;
  params: unknown[];
  /** Columns produced by array_agg(): JSON strings that must be parsed. */
  jsonColumns: string[];
}

/** D1 rejects more than 100 bound parameters per statement. */
export const D1_MAX_PARAMS = 100;

// ---------------------------------------------------------------------------
// Low level text helpers (string-literal aware)
// ---------------------------------------------------------------------------

function isIdentChar(ch: string) {
  return /[\w.$"]/.test(ch);
}

/** Index of the `)` matching the `(` at `open`. */
export function findClosingParen(sql: string, open: number): number {
  let depth = 0;
  let inString = false;

  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new SqliteTranslateError(`Unbalanced parentheses near: ${sql.slice(open, open + 80)}`);
}

/** Index of the `(` matching the `)` at `close`, scanning backwards. */
function findOpeningParen(sql: string, close: number): number {
  let depth = 0;

  for (let i = close; i >= 0; i--) {
    const ch = sql[i];

    if (ch === "'") {
      // skip backwards over a string literal
      let j = i - 1;
      while (j >= 0 && sql[j] !== "'") j--;
      i = j;
      continue;
    }

    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new SqliteTranslateError(
    `Unbalanced parentheses near: ${sql.slice(Math.max(0, close - 80), close)}`,
  );
}

/**
 * Start index of the operand that ends right before `end` (exclusive).
 * Handles identifiers, `{{placeholders}}`, string literals, and
 * `func(...)` / `(...)` groups.
 */
function operandStart(sql: string, end: number): number {
  let i = end - 1;
  while (i >= 0 && /\s/.test(sql[i])) i--;

  if (i < 0) throw new SqliteTranslateError('Missing operand');

  const ch = sql[i];

  if (ch === ')') {
    const open = findOpeningParen(sql, i);
    let j = open - 1;
    // function call (name directly before the paren): include the function name
    if (j >= 0 && /[\w.]/.test(sql[j])) {
      while (j >= 0 && /[\w.]/.test(sql[j])) j--;
      return j + 1;
    }
    return open;
  }

  if (ch === '}' && sql[i - 1] === '}') {
    const open = sql.lastIndexOf('{{', i);
    if (open === -1) throw new SqliteTranslateError('Unbalanced placeholder');
    return open;
  }

  if (ch === "'") {
    let j = i - 1;
    while (j >= 0 && sql[j] !== "'") j--;
    return j;
  }

  let j = i;
  while (j >= 0 && isIdentChar(sql[j])) j--;
  return j + 1;
}

/** Split `args` on top-level commas. */
export function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];

    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }

    if (ch === "'") inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) parts.push(current.trim());

  return parts;
}

/** Find `token` (regex source) at paren depth 0 and outside string literals. */
function findTopLevel(sql: string, pattern: RegExp, from = 0): RegExpExecArray | null {
  let depth = 0;
  let inString = false;
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );

  for (let i = from; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }

    if (ch === "'") inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(sql);
      if (m && m.index === i) return m;
    }
  }

  return null;
}

/** Rewrite every `name(...)` call (string-literal aware, nested-paren safe). */
export function rewriteCalls(
  sql: string,
  name: string,
  replace: (args: string, parts: string[]) => string,
): string {
  const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'gi');
  let out = '';
  let cursor = 0;

  for (;;) {
    re.lastIndex = cursor;
    const m = re.exec(sql);
    if (!m) break;

    const open = m.index + m[0].length - 1;

    if (isInsideString(sql, m.index)) {
      out += sql.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }

    const close = findClosingParen(sql, open);
    const args = sql.slice(open + 1, close);

    out += sql.slice(cursor, m.index);
    out += replace(args, splitArgs(args));
    cursor = close + 1;
  }

  return out + sql.slice(cursor);
}

function isInsideString(sql: string, index: number): boolean {
  let inString = false;
  for (let i = 0; i < index; i++) {
    if (sql[i] === "'") inString = !inString;
  }
  return inString;
}

function isInsidePlaceholder(sql: string, index: number): boolean {
  const open = sql.lastIndexOf('{{', index);
  if (open === -1) return false;
  const close = sql.indexOf('}}', open);
  return close !== -1 && close > index;
}

function stripOuterParens(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && findClosingParen(e, 0) === e.length - 1) {
    e = e.slice(1, -1).trim();
  }
  return e;
}

/** Split `a - b` at the top-level minus (last occurrence). */
function splitTopLevelMinus(expr: string): [string, string] | null {
  let depth = 0;
  let inString = false;

  for (let i = expr.length - 1; i >= 0; i--) {
    const ch = expr[i];
    if (ch === "'") inString = !inString;
    if (inString) continue;
    if (ch === ')') depth++;
    else if (ch === '(') depth--;
    else if (
      ch === '-' &&
      depth === 0 &&
      /\s/.test(expr[i - 1] ?? '') &&
      /\s/.test(expr[i + 1] ?? '')
    ) {
      return [expr.slice(0, i).trim(), expr.slice(i + 1).trim()];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

const JSON_EACH_GUARD = (expr: string) =>
  `json_each(case when json_valid(${expr}) then ${expr} else '[]' end)`;

/** `cross join lateral jsonb_array_elements_text(x::jsonb) as t(value)` -> `cross join json_each(x) as t` */
function passJsonArray(sql: string): string {
  let out = sql.replace(/\bcross\s+join\s+lateral\b/gi, 'cross join');

  out = rewriteCalls(out, 'jsonb_array_elements_text', args => {
    const expr = args.trim().replace(/::jsonb\s*$/i, '');
    return JSON_EACH_GUARD(expr);
  });

  // table alias `as array_item(value)` -> `as array_item` (json_each exposes `value`)
  out = out.replace(/\bas\s+(\w+)\(value\)/gi, 'as $1');

  return out;
}

/**
 * `select distinct on (k) cols from ... order by k, o` ->
 * `select cols from (select cols, row_number() over (partition by k order by o) as __rn from ...) where __rn = 1`
 */
function passDistinctOn(sql: string): string {
  const re = /select\s+distinct\s+on\s*\(/i;
  let out = sql;

  for (;;) {
    const m = re.exec(out);
    if (!m) break;

    const keyOpen = m.index + m[0].length - 1;
    const keyClose = findClosingParen(out, keyOpen);
    const keys = out.slice(keyOpen + 1, keyClose).trim();

    // The subquery ends at the closing paren enclosing the SELECT, or end of string.
    let end: number;
    try {
      end = findEnclosingClose(out, m.index);
    } catch {
      end = out.length;
    }

    const body = out.slice(keyClose + 1, end);
    const fromMatch = findTopLevel(body, /\bfrom\b/i);
    if (!fromMatch) throw new SqliteTranslateError('distinct on: missing FROM');

    const columns = body.slice(0, fromMatch.index).trim();
    let rest = body.slice(fromMatch.index);
    let orderBy = '';

    const orderMatch = findTopLevel(rest, /\border\s+by\b/i);
    if (orderMatch) {
      orderBy = rest.slice(orderMatch.index + orderMatch[0].length).trim();
      rest = rest.slice(0, orderMatch.index);
    }

    const keyList = splitArgs(keys).map(k => k.trim());
    const orderCols = orderBy
      ? splitArgs(orderBy).filter(o => !keyList.includes(o.replace(/\s+(asc|desc)$/i, '').trim()))
      : [];

    const rewritten = `select ${columns} from (select ${columns}, row_number() over (partition by ${keys}${
      orderCols.length ? ` order by ${orderCols.join(', ')}` : ''
    }) as __rn ${rest.trim()}) where __rn = 1`;

    out = out.slice(0, m.index) + rewritten + out.slice(end);
  }

  return out;
}

/** Position of the `)` that closes the group containing `index` (or -1). */
function findEnclosingClose(sql: string, index: number): number {
  let depth = 0;
  let inString = false;
  for (let i = index; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return i;
      depth--;
    }
  }
  throw new SqliteTranslateError('No enclosing group');
}

/**
 * `select a, b, agg from src group by grouping sets ((a, b), (a)) order by ...` ->
 * `select a, b, agg from src group by a, b union all select a, null as b, agg from src group by a order by ...`
 * SQLite has no GROUPING SETS; umami uses it for per-website subtotal rows.
 */
function passGroupingSets(sql: string): string {
  const re = /\bgroup\s+by\s+grouping\s+sets\s*\(/i;
  let out = sql;

  for (;;) {
    const m = re.exec(out);
    if (!m) break;

    const setsOpen = m.index + m[0].length - 1;
    const setsClose = findClosingParen(out, setsOpen);
    const sets = splitArgs(out.slice(setsOpen + 1, setsClose)).map(set =>
      splitArgs(stripOuterParens(set)).map(c => c.trim()),
    );

    // statement boundaries at this nesting level
    let stmtStart = 0;
    let depth = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      const ch = out[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) {
          stmtStart = i + 1;
          break;
        }
        depth--;
      }
    }

    let stmtEnd: number;
    try {
      stmtEnd = findEnclosingClose(out, setsClose + 1);
    } catch {
      stmtEnd = out.length;
    }

    const head = out.slice(stmtStart, m.index);
    const trailing = out.slice(setsClose + 1, stmtEnd);

    // last top-level SELECT before the grouping clause
    let selectIdx = -1;
    let from = 0;
    for (;;) {
      const sm = findTopLevel(head, /\bselect\b/i, from);
      if (!sm) break;
      selectIdx = sm.index;
      from = sm.index + sm[0].length;
    }
    if (selectIdx === -1) throw new SqliteTranslateError('grouping sets: SELECT not found');

    const afterSelect = head.slice(selectIdx + 'select'.length);
    const fromMatch = findTopLevel(afterSelect, /\bfrom\b/i);
    if (!fromMatch) throw new SqliteTranslateError('grouping sets: FROM not found');

    const items = splitArgs(afterSelect.slice(0, fromMatch.index));
    const body = afterSelect.slice(fromMatch.index).trim();
    const allColumns = new Set(sets.flat().map(c => c.replace(/"/g, '')));

    const nameOf = (item: string) => {
      const alias = /\s+as\s+("?[\w]+"?)\s*$/i.exec(item);
      return (alias ? alias[1] : item).trim().replace(/"/g, '');
    };

    const members = sets.map(set => {
      const keep = new Set(set.map(c => c.replace(/"/g, '')));
      const selectList = items
        .map(item => {
          const name = nameOf(item);
          if (allColumns.has(name) && !keep.has(name)) {
            return `null as "${name}"`;
          }
          return item.trim();
        })
        .join(', ');
      return `select ${selectList} ${body} group by ${set.join(', ')}`;
    });

    const rewritten = `${head.slice(0, selectIdx)}${members.join(' union all ')}${trailing}`;
    out = out.slice(0, stmtStart) + rewritten + out.slice(stmtEnd);
  }

  return out;
}

/** percentile_cont(p) within group (order by x) -> interpolated percentile via json_group_array */
function percentileSQL(p: string, expr: string): string {
  const arr = `json_group_array(${expr} order by ${expr}) filter (where ${expr} is not null)`;
  const n = `json_array_length(${arr})`;
  const pos = `((${n} - 1) * ${p})`;
  const lo = `cast(${pos} as integer)`;
  const hi = `min(${lo} + 1, ${n} - 1)`;
  const frac = `(${pos} - ${lo})`;

  return `(case when ${n} = 0 then null else json_extract(${arr}, '$[' || ${lo} || ']') * (1 - ${frac}) + json_extract(${arr}, '$[' || ${hi} || ']') * ${frac} end)`;
}

function passAggregates(sql: string, jsonColumns: string[]): string {
  let out = sql.replace(
    /percentile_cont\s*\(\s*([\d.]+)\s*\)\s*within\s+group\s*\(\s*order\s+by\s+([^()]+?)\s*\)/gi,
    (_, p, expr) => percentileSQL(p, expr.trim()),
  );

  // mode() within group (order by x): SQLite evaluates an aggregate inside a
  // correlated scalar subquery in the enclosing group, so the most frequent value
  // can be picked from json_group_array(x). Ties resolve to the smallest value,
  // matching Postgres' "first in sort order" behaviour. NULLs are ignored.
  out = out.replace(
    /mode\s*\(\s*\)\s*within\s+group\s*\(\s*order\s+by\s+([^()]+?)(?:\s+(?:asc|desc))?\s*\)/gi,
    (_, expr) =>
      `(select value from json_each(json_group_array(${expr})) where value is not null group by value order by count(*) desc, value limit 1)`,
  );

  out = out.replace(/\bbool_or\s*\(/gi, 'max(');

  // array_agg(x order by k) -> json_group_array(x order by k); remember alias for JSON.parse
  const re = /(?<![\w.])array_agg\s*\(/gi;
  let result = '';
  let cursor = 0;
  for (;;) {
    re.lastIndex = cursor;
    const m = re.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = findClosingParen(out, open);
    const args = out.slice(open + 1, close);
    const after = out.slice(close + 1);
    const alias = /^\s+as\s+"?(\w+)"?/i.exec(after);
    if (alias) jsonColumns.push(alias[1]);
    result += `${out.slice(cursor, m.index)}json_group_array(${args})`;
    cursor = close + 1;
  }
  out = result + out.slice(cursor);

  return out;
}

/** regexp_replace(x, '^www.', '') -> strip a leading "www." */
function passRegexpReplace(sql: string): string {
  return rewriteCalls(sql, 'regexp_replace', (args, parts) => {
    const [expr, pattern, replacement] = parts;
    if (pattern === "'^www.'" && replacement === "''") {
      return `(case when ${expr} like 'www_%' then substr(${expr}, 5) else ${expr} end)`;
    }
    throw new SqliteTranslateError(`Unsupported regexp_replace(${args})`);
  });
}

/** `x at time zone 'Zone'` / `x at time zone {{timezone}}` -> local datetime expression */
function passAtTimeZone(sql: string, data: Record<string, unknown>): string {
  return sql.replace(
    /([\w."]+)\s+at\s+time\s+zone\s+(?:'([^']*)'|\{\{\s*(\w+)\s*\}\})/gi,
    (_, field, literal, param) => {
      const tz = literal ?? (data[param] as string | undefined);
      return getLocalTimeSQL(field, tz);
    },
  );
}

function passDateTrunc(sql: string): string {
  return rewriteCalls(sql, 'date_trunc', (_args, parts) => {
    const unit = parts[0].replace(/'/g, '').trim().toLowerCase();
    const expr = parts[1];

    switch (unit) {
      case 'minute':
        return `strftime('%Y-%m-%d %H:%M:00', ${expr})`;
      case 'hour':
        return `strftime('%Y-%m-%d %H:00:00', ${expr})`;
      case 'day':
        return `datetime(${expr}, 'start of day')`;
      case 'week':
        return `datetime(${expr}, 'start of day', '-' || ((cast(strftime('%w', ${expr}) as integer) + 6) % 7) || ' days')`;
      case 'month':
        return `datetime(${expr}, 'start of month')`;
      case 'year':
        return `datetime(${expr}, 'start of year')`;
      default:
        throw new SqliteTranslateError(`Unsupported date_trunc unit: ${unit}`);
    }
  });
}

export function mapToCharFormat(format: string): string {
  return format.replace(/^'|'$/g, '').replace(/YYYY|HH24|HH|MM|DD|MI|SS|"[^"]*"|./g, token => {
    switch (token) {
      case 'YYYY':
        return '%Y';
      case 'MM':
        return '%m';
      case 'DD':
        return '%d';
      case 'HH24':
      case 'HH':
        return '%H';
      case 'MI':
        return '%M';
      case 'SS':
        return '%S';
      default:
        return token.startsWith('"') ? token.slice(1, -1) : token;
    }
  });
}

function passToChar(sql: string): string {
  return rewriteCalls(sql, 'to_char', (_args, parts) => {
    const [expr, format] = parts;
    return `strftime('${mapToCharFormat(format)}', ${expr})`;
  });
}

function passExtract(sql: string): string {
  return rewriteCalls(sql, 'extract', args => {
    const m = /^\s*(\w+)\s+from\s+([\s\S]+)$/i.exec(args);
    if (!m) throw new SqliteTranslateError(`Unsupported extract(${args})`);
    const field = m[1].toLowerCase();
    const expr = stripOuterParens(m[2]);

    switch (field) {
      case 'epoch': {
        const diff = splitTopLevelMinus(expr);
        if (diff) {
          return `(unixepoch(${diff[0]}, 'subsec') - unixepoch(${diff[1]}, 'subsec'))`;
        }
        return `unixepoch(${expr}, 'subsec')`;
      }
      case 'hour':
        return `cast(strftime('%H', ${expr}) as integer)`;
      case 'minute':
        return `cast(strftime('%M', ${expr}) as integer)`;
      case 'dow':
        return `cast(strftime('%w', ${expr}) as integer)`;
      case 'day':
        return `cast(strftime('%d', ${expr}) as integer)`;
      case 'month':
        return `cast(strftime('%m', ${expr}) as integer)`;
      case 'year':
        return `cast(strftime('%Y', ${expr}) as integer)`;
      default:
        throw new SqliteTranslateError(`Unsupported extract field: ${field}`);
    }
  });
}

const INTERVAL_UNITS: Record<string, string> = {
  second: 'seconds',
  seconds: 'seconds',
  minute: 'minutes',
  minutes: 'minutes',
  hour: 'hours',
  hours: 'hours',
  day: 'days',
  days: 'days',
  week: 'days',
  weeks: 'days',
  month: 'months',
  months: 'months',
  year: 'years',
  years: 'years',
};

/**
 * `base + interval '5 minute'`, `base + interval 5 minute`,
 * `base + mult * interval '4 hour'` -> strftime(canonical, base, '+N units')
 */
function passInterval(sql: string): string {
  const re = /\binterval\s+(?:'(\d+)\s+(\w+)'|(\d+)\s+(\w+))/gi;
  let out = sql;

  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) break;

    let amount = Number(m[1] ?? m[3]);
    const unit = (m[2] ?? m[4]).toLowerCase();
    if (unit.startsWith('week')) amount *= 7;
    const sqlUnit = INTERVAL_UNITS[unit];
    if (!sqlUnit) throw new SqliteTranslateError(`Unsupported interval unit: ${unit}`);

    const intervalEnd = m.index + m[0].length;
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(out[i])) i--;

    let multiplier: string | null = null;

    if (out[i] === '*') {
      const multStart = operandStart(out, i);
      multiplier = out.slice(multStart, i).trim();
      i = multStart - 1;
      while (i >= 0 && /\s/.test(out[i])) i--;
    }

    if (out[i] !== '+') {
      throw new SqliteTranslateError(
        `Unsupported interval expression near: ${out.slice(Math.max(0, i - 40), intervalEnd)}`,
      );
    }

    const baseStart = operandStart(out, i);
    const base = out.slice(baseStart, i).trim();

    const modifier = multiplier
      ? `'+' || ((${multiplier}) * ${amount}) || ' ${sqlUnit}'`
      : `'+${amount} ${sqlUnit}'`;

    out = `${out.slice(0, baseStart)}strftime('${CANONICAL_TIMESTAMP_FORMAT}', ${base}, ${modifier})${out.slice(intervalEnd)}`;
  }

  return out;
}

function passNow(sql: string): string {
  return sql.replace(/\bnow\s*\(\s*\)/gi, `strftime('${CANONICAL_TIMESTAMP_FORMAT}', 'now')`);
}

/** Postgres `expr::type` casts. */
function passColonCasts(sql: string): string {
  // `::type`, `::type[]` (array casts only ever wrap list params), `::double precision`
  const re = /::\s*([a-z]+)(?:\s+precision)?(?:\[\])?/gi;
  const matches: { index: number; length: number; type: string }[] = [];

  for (;;) {
    const m = re.exec(sql);
    if (!m) break;
    if (isInsidePlaceholder(sql, m.index) || isInsideString(sql, m.index)) continue;
    matches.push({ index: m.index, length: m[0].length, type: m[1].toLowerCase() });
  }

  let out = sql;

  // right-to-left so earlier indices stay valid
  for (const { index, length, type } of matches.reverse()) {
    const start = operandStart(out, index);
    const operand = out.slice(start, index).trim();
    let replacement: string;

    switch (type) {
      case 'uuid':
      case 'jsonb':
      case 'json':
      case 'timestamp':
      case 'timestamptz':
      case 'interval':
        replacement = operand;
        break;
      case 'date':
        replacement = `date(${operand})`;
        break;
      case 'int':
      case 'int2':
      case 'int4':
      case 'int8':
      case 'integer':
      case 'bigint':
      case 'smallint':
        replacement = `cast(${operand} as integer)`;
        break;
      case 'float':
      case 'float4':
      case 'float8':
      case 'double':
      case 'real':
      case 'decimal':
      case 'numeric':
        replacement = `cast(${operand} as real)`;
        break;
      case 'text':
      case 'varchar':
        replacement = `cast(${operand} as text)`;
        break;
      default:
        throw new SqliteTranslateError(`Unsupported cast ::${type}`);
    }

    out = out.slice(0, start) + replacement + out.slice(index + length);
  }

  return out;
}

/** `date(a) - date(b)` -> whole days between the two dates */
function passDateDiff(sql: string): string {
  const re = /(?<![\w.])date\s*\(/gi;
  let out = sql;
  let cursor = 0;

  for (;;) {
    re.lastIndex = cursor;
    const m = re.exec(out);
    if (!m) break;

    const open1 = m.index + m[0].length - 1;
    const close1 = findClosingParen(out, open1);
    const between = /^\s*-\s*date\s*\(/i.exec(out.slice(close1 + 1));

    if (!between) {
      cursor = close1 + 1;
      continue;
    }

    const open2 = close1 + 1 + between[0].length - 1;
    const close2 = findClosingParen(out, open2);
    const a = out.slice(open1 + 1, close1);
    const b = out.slice(open2 + 1, close2);
    const replacement = `cast(julianday(${a}) - julianday(${b}) as integer)`;

    out = out.slice(0, m.index) + replacement + out.slice(close2 + 1);
    cursor = m.index + replacement.length;
  }

  return out;
}

function passCast(sql: string): string {
  return rewriteCalls(sql, 'cast', args => {
    const m = /^([\s\S]+)\s+as\s+([a-z\s()0-9,]+)$/i.exec(args.trim());
    if (!m) return `cast(${args})`;
    const expr = m[1];
    const type = m[2]
      .trim()
      .toLowerCase()
      .replace(/\(.*\)/, '')
      .trim();

    if (/^(bigint|int|integer|smallint|int2|int4|int8)$/.test(type))
      return `cast(${expr} as integer)`;
    if (/^(decimal|numeric|float|float4|float8|real|double precision|double)$/.test(type)) {
      return `cast(${expr} as real)`;
    }
    if (/^(varchar|text|char|character varying)$/.test(type)) return `cast(${expr} as text)`;
    if (type === 'date') return `date(${expr})`;
    if (/^(uuid|timestamp|timestamptz|timestamp with time zone)$/.test(type)) return expr;

    return `cast(${expr} as ${type})`;
  });
}

function passOperators(
  sql: string,
  data: Record<string, unknown>,
  listParams: Set<string>,
  regexParams: Map<string, string[]>,
  containsParams: Set<string>,
): string {
  let out = sql;

  // `col ilike {{p}}` where the bound value is `%text%` (umami's contains/search
  // filters) becomes `instr(lower(col), lower(text)) > 0`: same result, but free of
  // D1's 50-byte LIKE/GLOB pattern limit. Other ilike uses fall back to `like`.
  const ilikeRe = /\b(not\s+)?ilike\s+\{\{\s*(\w+)[^}]*\}\}/gi;
  let im: RegExpExecArray | null = ilikeRe.exec(out);
  while (im) {
    const [whole, not, name] = im;
    const value = data[name];
    if (typeof value === 'string' && /^%[^%_]+%$/.test(value)) {
      const start = operandStart(out, im.index);
      const column = out.slice(start, im.index).trim();
      containsParams.add(name);
      const replacement = `instr(lower(${column}), {{${name}::contains}}) ${not ? '=' : '>'} 0`;
      out = out.slice(0, start) + replacement + out.slice(im.index + whole.length);
      ilikeRe.lastIndex = start + replacement.length;
    }
    im = ilikeRe.exec(out);
  }

  out = out.replace(/\bnot\s+ilike\b/gi, 'not like').replace(/\bilike\b/gi, 'like');

  // `= ANY({{p}})` / `!= ALL({{p}})`: the array is bound as one JSON parameter and
  // expanded with json_each(), so long lists never hit D1's 100-parameter limit.
  out = out.replace(/=\s*any\s*\(\s*(\{\{\s*(\w+)[^}]*\}\})\s*\)/gi, (_, ph, name) => {
    listParams.add(name);
    return `in (select value from json_each(${ph}))`;
  });

  out = out.replace(/!=\s*all\s*\(\s*(\{\{\s*(\w+)[^}]*\}\})\s*\)/gi, (_, ph, name) => {
    listParams.add(name);
    return `not in (select value from json_each(${ph}))`;
  });

  // `col ~* {{p}}` / `col !~* {{p}}`: compile the regex into GLOB patterns
  // (one per alternation branch) applied to lower(col).
  const regexRe = /(!?)~\*\s*\{\{\s*(\w+)[^}]*\}\}/g;
  let m: RegExpExecArray | null = regexRe.exec(out);
  while (m) {
    const [whole, not, name] = m;
    const value = data[name];
    if (typeof value !== 'string') {
      throw new SqliteTranslateError(`Regex filter ${name} must be a string`);
    }
    const start = operandStart(out, m.index);
    const column = out.slice(start, m.index).trim();
    const patterns = regexToGlob(value);
    regexParams.set(name, patterns);
    const clauses = patterns.map((_, i) => `lower(${column}) glob {{${name}::glob${i}}}`);
    const replacement = `${not ? 'not ' : ''}(${clauses.join(' or ')})`;
    out = out.slice(0, start) + replacement + out.slice(m.index + whole.length);
    regexRe.lastIndex = start + replacement.length;
    m = regexRe.exec(out);
  }

  out = rewriteCalls(out, 'left', (_args, parts) => `substr(${parts[0]}, 1, ${parts[1]})`);
  out = out.replace(/(?<![\w.])position\s*\(/gi, 'instr(');
  out = rewriteCalls(
    out,
    'concat',
    (_args, parts) => `(${parts.map(p => `coalesce(${p}, '')`).join(' || ')})`,
  );

  return out;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** D1 rejects LIKE/GLOB patterns longer than this ("pattern too complex"). */
export const D1_MAX_PATTERN_BYTES = 50;
/** Hard cap on the number of GLOB patterns one regex may expand to. */
const MAX_GLOB_PATTERNS = 64;
/** Upper bound used when expanding unbounded repetition (`+`, `*`, `{n,}`). */
const MAX_REPEAT = 12;

const ANCHOR_START = '\u0001';
const ANCHOR_END = '\u0002';

/**
 * Compile a regular expression (as used by umami's "matches regex" filters, Postgres
 * `~*` semantics) into one or more lower-cased SQLite GLOB patterns.
 *
 * Supported: `^`/`$` anchors, `.`, escaped literals, `\d \w \s` (and negations),
 * character classes `[...]`, groups `(...)`/`(?:...)`, alternation `a|b`, and the
 * quantifiers `* + ? {n} {n,m} {n,}`. Alternation and quantifiers are expanded into
 * separate patterns (repetition is bounded at MAX_REPEAT), which is exact up to that
 * bound. Anything else throws a SqliteTranslateError.
 */
export function regexToGlob(pattern: string): string[] {
  const compiler = new RegexGlobCompiler(pattern);
  const alternatives = compiler.compile();

  const globs = alternatives.map(alt => {
    let glob = alt;
    let anchoredStart = false;
    let anchoredEnd = false;
    if (glob.startsWith(ANCHOR_START)) {
      anchoredStart = true;
      glob = glob.slice(1);
    }
    if (glob.endsWith(ANCHOR_END)) {
      anchoredEnd = true;
      glob = glob.slice(0, -1);
    }
    if (glob.includes(ANCHOR_START) || glob.includes(ANCHOR_END)) {
      throw new SqliteTranslateError('Regex anchors are only supported at the start and end');
    }
    const prefix = anchoredStart || glob.startsWith('*') ? '' : '*';
    const suffix = anchoredEnd || glob.endsWith('*') ? '' : '*';
    return `${prefix}${glob}${suffix}`.toLowerCase();
  });

  // D1 rejects patterns above 50 bytes. Variants produced by unbounded repetition
  // (`+`, `*`, `{n,}`) that do not fit are dropped: the match is then exact up to the
  // number of repeats that fits. Anything else over the limit is an error.
  const fitting = globs.filter(g => Buffer.byteLength(g) <= D1_MAX_PATTERN_BYTES);
  if (fitting.length < globs.length && (!compiler.unbounded || fitting.length === 0)) {
    const longest = Math.max(...globs.map(g => Buffer.byteLength(g)));
    throw new SqliteTranslateError(
      `Regex filter expands to a ${longest}-byte pattern; Cloudflare D1 allows at most ${D1_MAX_PATTERN_BYTES}. Shorten the pattern or use "contains".`,
    );
  }
  return fitting;
}

class RegexGlobCompiler {
  private pos = 0;
  /** Set when the pattern used `+`, `*` or `{n,}` (expansion is bounded at MAX_REPEAT). */
  unbounded = false;

  constructor(private readonly src: string) {}

  compile(): string[] {
    const result = this.parseAlternation();
    if (this.pos < this.src.length) {
      throw new SqliteTranslateError(`Unexpected "${this.src[this.pos]}" in regex`);
    }
    return result;
  }

  private parseAlternation(): string[] {
    let branches = this.parseSequence();
    while (this.src[this.pos] === '|') {
      this.pos++;
      branches = branches.concat(this.parseSequence());
      this.checkSize(branches.length);
    }
    return branches;
  }

  private parseSequence(): string[] {
    let acc: string[] = [''];
    while (this.pos < this.src.length && this.src[this.pos] !== '|' && this.src[this.pos] !== ')') {
      const atom = this.parseAtom();
      const expanded = this.applyQuantifier(atom);
      const next: string[] = [];
      for (const a of acc) for (const b of expanded) next.push(a + b);
      this.checkSize(next.length);
      acc = next;
    }
    return acc;
  }

  /** Returns the alternatives for one atom (a group may have several). */
  private parseAtom(): string[] {
    const ch = this.src[this.pos];

    if (ch === '^') {
      this.pos++;
      return [ANCHOR_START];
    }
    if (ch === '$') {
      this.pos++;
      return [ANCHOR_END];
    }
    if (ch === '(') {
      this.pos++;
      if (this.src.startsWith('?:', this.pos)) this.pos += 2;
      else if (this.src[this.pos] === '?') {
        throw new SqliteTranslateError('Lookaround and named groups are not supported');
      }
      const inner = this.parseAlternation();
      if (this.src[this.pos] !== ')') throw new SqliteTranslateError('Unbalanced ( in regex');
      this.pos++;
      return inner;
    }
    if (ch === '[') {
      return [this.parseClass()];
    }
    if (ch === '\\') {
      this.pos++;
      const next = this.src[this.pos++];
      if (next === undefined) throw new SqliteTranslateError('Trailing backslash in regex');
      return [this.escapeToGlob(next)];
    }
    if (ch === '.') {
      this.pos++;
      // `.*` and `.+` map directly onto GLOB wildcards
      if (this.src[this.pos] === '*') {
        this.pos++;
        return ['*'];
      }
      if (this.src[this.pos] === '+') {
        this.pos++;
        return ['?*'];
      }
      return ['?'];
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      throw new SqliteTranslateError(`Nothing to repeat before "${ch}" in regex`);
    }
    this.pos++;
    return [globLiteral(ch)];
  }

  private parseClass(): string {
    // assumes src[pos] === '['
    this.pos++;
    let out = '[';
    if (this.src[this.pos] === '^') {
      out += '^';
      this.pos++;
    }
    let first = true;
    while (this.pos < this.src.length && (first || this.src[this.pos] !== ']')) {
      const ch = this.src[this.pos++];
      first = false;
      if (ch === '\\') {
        const next = this.src[this.pos++];
        if (next === undefined) throw new SqliteTranslateError('Trailing backslash in regex');
        out += CLASS_ESCAPES[next] ?? (next === ']' ? ']' : next);
        continue;
      }
      out += ch;
    }
    if (this.src[this.pos] !== ']') throw new SqliteTranslateError('Unbalanced [ in regex');
    this.pos++;
    return `${out}]`;
  }

  private escapeToGlob(ch: string): string {
    const cls = CLASS_ESCAPES[ch];
    if (cls) return ch === ch.toUpperCase() && /[DWS]/.test(ch) ? `[^${cls}]` : `[${cls}]`;
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    if (/[a-z0-9]/i.test(ch)) throw new SqliteTranslateError(`Unsupported escape \\${ch} in regex`);
    return globLiteral(ch);
  }

  private applyQuantifier(atom: string[]): string[] {
    const ch = this.src[this.pos];
    let min: number;
    let max: number;

    if (ch === '*') {
      min = 0;
      max = MAX_REPEAT;
      this.unbounded = true;
      this.pos++;
    } else if (ch === '+') {
      min = 1;
      max = MAX_REPEAT;
      this.unbounded = true;
      this.pos++;
    } else if (ch === '?') {
      min = 0;
      max = 1;
      this.pos++;
    } else if (ch === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(this.pos));
      if (!m) throw new SqliteTranslateError('Unsupported {} quantifier in regex');
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : min + MAX_REPEAT - 1) : min;
      if (m[2] && !m[3]) this.unbounded = true;
      if (max < min) throw new SqliteTranslateError('Invalid {} quantifier in regex');
      this.pos += m[0].length;
    } else {
      return atom;
    }

    if (this.src[this.pos] === '?') this.pos++; // lazy modifier: irrelevant for matching

    if (atom.some(a => a.includes(ANCHOR_START) || a.includes(ANCHOR_END))) {
      throw new SqliteTranslateError('Cannot repeat an anchor in regex');
    }

    // A wildcard atom repeated is still a wildcard.
    if (atom.length === 1 && atom[0] === '?' && max >= MAX_REPEAT) {
      return [min === 0 ? '*' : `${'?'.repeat(min)}*`];
    }

    const out = new Set<string>();
    for (let n = min; n <= max; n++) {
      let reps: string[] = [''];
      for (let i = 0; i < n; i++) {
        const next: string[] = [];
        for (const r of reps) for (const a of atom) next.push(r + a);
        reps = next;
        this.checkSize(reps.length);
      }
      for (const r of reps) out.add(r);
      this.checkSize(out.size);
    }
    return [...out];
  }

  private checkSize(n: number) {
    if (n > MAX_GLOB_PATTERNS) {
      throw new SqliteTranslateError(
        'Regex filter is too complex for Cloudflare D1; simplify the pattern or use "contains"',
      );
    }
  }
}

const CLASS_ESCAPES: Record<string, string> = {
  d: '0-9',
  D: '0-9',
  w: 'a-zA-Z0-9_',
  W: 'a-zA-Z0-9_',
  s: ' \t\n\r',
  S: ' \t\n\r',
};

/** Escape a literal character for use in a GLOB pattern. */
function globLiteral(ch: string): string {
  return ch === '*' || ch === '?' || ch === '[' ? `[${ch}]` : ch;
}

export function toSqliteValue(value: unknown, type?: string): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return type === 'date' ? value.toISOString().slice(0, 10) : toCanonicalTimestamp(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function passParams(
  sql: string,
  data: Record<string, unknown>,
  listParams: Set<string>,
  regexParams: Map<string, string[]>,
  containsParams: Set<string>,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];

  const out = sql.replace(/\{\{\s*(\w+)(?:::(\w+))?\s*\}\}/g, (_, name, type) => {
    const value = data[name];

    if (type === 'contains' && containsParams.has(name)) {
      params.push(String(value).slice(1, -1).toLowerCase());
      return '?';
    }

    const globMatch = /^glob(\d+)$/.exec(type ?? '');
    if (globMatch) {
      const patterns = regexParams.get(name);
      if (!patterns) throw new SqliteTranslateError(`Unknown regex parameter ${name}`);
      params.push(patterns[Number(globMatch[1])]);
      return '?';
    }

    if (listParams.has(name) || Array.isArray(value)) {
      // bound as a JSON array; the SQL side reads it through json_each()
      const values = Array.isArray(value) ? value : [value];
      params.push(JSON.stringify(values.map(v => toSqliteValue(v, type))));
      return '?';
    }

    params.push(toSqliteValue(value, type));
    return '?';
  });

  return { sql: out, params };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function translateQuery(sql: string, data: Record<string, unknown> = {}): TranslatedQuery {
  const jsonColumns: string[] = [];
  const listParams = new Set<string>();
  const regexParams = new Map<string, string[]>();
  const containsParams = new Set<string>();

  let out = sql;
  out = passJsonArray(out);
  out = passDistinctOn(out);
  out = passGroupingSets(out);
  out = passAggregates(out, jsonColumns);
  out = passRegexpReplace(out);
  out = passAtTimeZone(out, data);
  out = passDateTrunc(out);
  out = passToChar(out);
  out = passExtract(out);
  out = passInterval(out);
  out = passNow(out);
  out = passColonCasts(out);
  out = passDateDiff(out);
  out = passCast(out);
  out = passOperators(out, data, listParams, regexParams, containsParams);

  const { sql: finalSql, params } = passParams(out, data, listParams, regexParams, containsParams);

  if (params.length > D1_MAX_PARAMS) {
    throw new SqliteTranslateError(
      `Query needs ${params.length} bound parameters; Cloudflare D1 allows at most ${D1_MAX_PARAMS}. Reduce the number of filter values.`,
    );
  }

  return { sql: finalSql, params, jsonColumns };
}

/** Parse JSON columns produced by array_agg() back into arrays. */
export function postProcessRows<T extends Record<string, unknown>>(
  rows: T[],
  jsonColumns: string[],
): T[] {
  if (!jsonColumns.length || !Array.isArray(rows)) return rows;

  for (const row of rows) {
    for (const column of jsonColumns) {
      const value = row[column];
      if (typeof value === 'string') {
        try {
          (row as Record<string, unknown>)[column] = JSON.parse(value);
        } catch {
          // leave as-is
        }
      }
    }
  }

  return rows;
}
