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

  // mode() has no SQLite equivalent; umami only uses it for page/viewport sizes
  // within a visit, where the values are effectively constant. max() is a safe stand-in.
  out = out.replace(
    /mode\s*\(\s*\)\s*within\s+group\s*\(\s*order\s+by\s+([^()]+?)\s*\)/gi,
    'max($1)',
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

function passOperators(sql: string, listParams: Set<string>, regexParams: Set<string>): string {
  let out = sql;

  out = out.replace(/\bnot\s+ilike\b/gi, 'not like').replace(/\bilike\b/gi, 'like');

  out = out.replace(/=\s*any\s*\(\s*(\{\{\s*(\w+)[^}]*\}\})\s*\)/gi, (_, ph, name) => {
    listParams.add(name);
    return `in ${ph}`;
  });

  out = out.replace(/!=\s*all\s*\(\s*(\{\{\s*(\w+)[^}]*\}\})\s*\)/gi, (_, ph, name) => {
    listParams.add(name);
    return `not in ${ph}`;
  });

  out = out.replace(/(!?)~\*\s*(\{\{\s*(\w+)[^}]*\}\})/g, (_, not, ph, name) => {
    regexParams.add(name);
    return `${not ? 'not like' : 'like'} ${ph}`;
  });

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

/** Convert a simple regular expression into a LIKE pattern, or throw. */
export function regexToLike(pattern: string): string {
  let p = pattern;
  let anchoredStart = false;
  let anchoredEnd = false;

  if (p.startsWith('^')) {
    anchoredStart = true;
    p = p.slice(1);
  }
  if (p.endsWith('$') && !p.endsWith('\\$')) {
    anchoredEnd = true;
    p = p.slice(0, -1);
  }

  let like = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') {
      const next = p[i + 1];
      if (next === undefined) throw new SqliteTranslateError('Unsupported regex');
      if (/[.*+?^$()[\]{}|\\/]/.test(next)) {
        like += next;
        i++;
        continue;
      }
      throw new SqliteTranslateError('Regex filters with escape sequences are not supported on D1');
    }
    if (ch === '.' && p[i + 1] === '*') {
      like += '%';
      i++;
      continue;
    }
    if (ch === '.') {
      like += '_';
      continue;
    }
    if (/[*+?()[\]{}|^$]/.test(ch)) {
      throw new SqliteTranslateError(
        'Regex filters are not supported on Cloudflare D1; use "contains" instead',
      );
    }
    like += ch;
  }

  const prefix = anchoredStart || like.startsWith('%') ? '' : '%';
  const suffix = anchoredEnd || like.endsWith('%') ? '' : '%';

  return `${prefix}${like}${suffix}`;
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
  regexParams: Set<string>,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];

  const out = sql.replace(/\{\{\s*(\w+)(?:::(\w+))?\s*\}\}/g, (_, name, type) => {
    const value = data[name];

    if (listParams.has(name) || Array.isArray(value)) {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) return '(null)';
      for (const v of values) params.push(toSqliteValue(v, type));
      return `(${values.map(() => '?').join(', ')})`;
    }

    if (regexParams.has(name) && typeof value === 'string') {
      params.push(regexToLike(value));
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
  const regexParams = new Set<string>();

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
  out = passOperators(out, listParams, regexParams);

  const { sql: finalSql, params } = passParams(out, data, listParams, regexParams);

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
