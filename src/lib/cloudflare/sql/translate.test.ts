import { describe, expect, test } from 'vitest';
import { getLocalTimeSQL, getOffsetSeconds, getZoneInfo, toCanonicalTimestamp } from './timezone';
import {
  mapToCharFormat,
  regexToGlob,
  SqliteTranslateError,
  translateQuery,
  translateUnsafe,
} from './translate';

describe('translateQuery', () => {
  test('binds {{params}} positionally and converts dates', () => {
    const { sql, params } = translateQuery(
      'select * from website_event where website_id = {{websiteId::uuid}} and created_at between {{startDate}} and {{endDate}}',
      {
        websiteId: 'abc',
        startDate: new Date('2024-01-01T00:00:00Z'),
        endDate: new Date('2024-01-02T00:00:00Z'),
      },
    );

    expect(sql).toBe(
      'select * from website_event where website_id = ? and created_at between ? and ?',
    );
    expect(params).toEqual([
      'abc',
      '2024-01-01T00:00:00.000+00:00',
      '2024-01-02T00:00:00.000+00:00',
    ]);
  });

  test('binds array params as JSON for = ANY / != ALL', () => {
    const { sql, params } = translateQuery(
      'where session.browser = ANY({{browser}}) and session.os != ALL({{os}})',
      { browser: ['chrome', 'firefox'], os: ['ios'] },
    );

    expect(sql).toBe(
      'where session.browser in (select value from json_each(?)) and session.os not in (select value from json_each(?))',
    );
    expect(params).toEqual(['["chrome","firefox"]', '["ios"]']);
  });

  test('long arrays stay within one bound parameter', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id${i}`);
    const { params } = translateQuery('where id = ANY({{ids::uuid}})', { ids });

    expect(params).toHaveLength(1);
    expect(JSON.parse(params[0] as string)).toHaveLength(500);
  });

  test('contains (ilike %x%) -> instr, regex -> glob', () => {
    const { sql, params } = translateQuery(
      'where a ilike {{s}} and b not ilike {{s}} and website_event.url_path ~* {{r}} and d !~* {{r}}',
      {
        s: '%X y%',
        r: '^/blog/.*',
      },
    );

    expect(sql).toBe(
      'where instr(lower(a), ?) > 0 and instr(lower(b), ?) = 0 and (lower(website_event.url_path) glob ?) and not (lower(d) glob ?)',
    );
    expect(params).toEqual(['x y', 'x y', '/blog/*', '/blog/*']);
  });

  test('ilike with other patterns stays like', () => {
    const { sql, params } = translateQuery('where a ilike {{s}} and b ilike {{t}}', {
      s: 'x%',
      t: '%a_b%',
    });

    expect(sql).toBe('where a like ? and b like ?');
    expect(params).toEqual(['x%', '%a_b%']);
  });

  test('regex patterns longer than 50 bytes are rejected', () => {
    expect(() => regexToGlob(`^/${'a'.repeat(60)}`)).toThrow(/at most 50/);
    expect(() => regexToGlob(`^/${'a'.repeat(60)}\\d+`)).toThrow(/at most 50/);
  });

  test('regex alternation expands to several glob clauses', () => {
    const { sql, params } = translateQuery('where c ~* {{r}}', { r: '^/(a|b)$' });

    expect(sql).toBe('where (lower(c) glob ? or lower(c) glob ?)');
    expect(params).toEqual(['/a', '/b']);
  });

  test('rejects regexes that cannot be expressed as GLOB', () => {
    expect(() => translateQuery('where c ~* {{r}}', { r: '^/(?=a)' })).toThrow(
      SqliteTranslateError,
    );
  });

  test('casts', () => {
    const { sql } = translateQuery(
      'select count(*)::int as c, cast(sum(x) as bigint) as s, cast(v as decimal) as d, (a)::date as dt, c.visitors::float * 100 from t',
    );

    expect(sql).toBe(
      'select cast(count(*) as integer) as c, cast(sum(x) as integer) as s, cast(v as real) as d, date((a)) as dt, cast(c.visitors as real) * 100 from t',
    );
  });

  test('date_trunc + to_char in UTC', () => {
    const { sql } = translateQuery(
      `to_char(date_trunc('day', website_event.created_at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
    );

    expect(sql).toBe(
      `strftime('%Y-%m-%dT%H:00:00Z', datetime(datetime(website_event.created_at), 'start of day'))`,
    );
  });

  test('date_trunc in a DST timezone emits an offset case expression', () => {
    const { sql } = translateQuery(`date_trunc('hour', x at time zone {{timezone}})`, {
      timezone: 'America/New_York',
    });

    expect(sql).toContain(`unixepoch(x) + (case when x >= '`);
    expect(sql).toContain('-14400');
    expect(sql).toContain('-18000');
    expect(sql.startsWith(`strftime('%Y-%m-%d %H:00:00', datetime(unixepoch(x) + (case`)).toBe(
      true,
    );
  });

  test('extract epoch / hour / dow', () => {
    const { sql } = translateQuery(
      `floor(extract(epoch from (b - a))), extract(epoch from sr.ended_at - sr.started_at) * 1000, extract(hour from c), extract(dow from (d at time zone 'UTC'))`,
    );

    expect(sql).toBe(
      `floor((unixepoch(b, 'subsec') - unixepoch(a, 'subsec'))), (unixepoch(sr.ended_at, 'subsec') - unixepoch(sr.started_at, 'subsec')) * 1000, cast(strftime('%H', c) as integer), cast(strftime('%w', datetime(d)) as integer)`,
    );
  });

  test('interval arithmetic', () => {
    const { sql } = translateQuery(
      `between l.created_at and l.created_at  + interval '5 minute' and x.created_at + interval 15 minute > now()`,
    );

    expect(sql).toBe(
      `between l.created_at and strftime('%Y-%m-%dT%H:%M:%f+00:00', l.created_at, '+5 minutes') and strftime('%Y-%m-%dT%H:%M:%f+00:00', x.created_at, '+15 minutes') > strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')`,
    );
  });

  test('bucketed interval with multiplier', () => {
    const { sql } = translateQuery(
      `to_char(date_trunc('day', e.created_at) + floor(extract(hour from e.created_at) / 4) * interval '4 hour', 'YYYY-MM-DD HH24:00:00')`,
    );

    expect(sql).toBe(
      `strftime('%Y-%m-%d %H:00:00', strftime('%Y-%m-%dT%H:%M:%f+00:00', datetime(e.created_at, 'start of day'), '+' || ((floor(cast(strftime('%H', e.created_at) as integer) / 4)) * 4) || ' hours'))`,
    );
  });

  test('day difference', () => {
    const { sql } = translateQuery(`select a::date - b.cohort_date::date as d`);

    expect(sql).toBe('select cast(julianday(a) - julianday(b.cohort_date) as integer) as d');
  });

  test('jsonb array elements -> json_each', () => {
    const { sql } = translateQuery(
      `from t cross join lateral jsonb_array_elements_text(coalesce(t.string_value, '[]')::jsonb) as array_item(value) where array_item.value = {{v}}`,
      { v: 'x' },
    );

    expect(sql).toBe(
      `from t cross join json_each(case when json_valid(coalesce(t.string_value, '[]')) then coalesce(t.string_value, '[]') else '[]' end) as array_item where array_item.value = ?`,
    );
  });

  test('array_agg -> json_group_array with alias tracking', () => {
    const { sql, jsonColumns } = translateQuery(
      `select array_agg(k order by k asc) as "propertyKeys", bool_or(x) as b from t`,
    );

    expect(sql).toBe(
      'select json_group_array(k order by k asc) as "propertyKeys", max(x) as b from t',
    );
    expect(jsonColumns).toEqual(['propertyKeys']);
  });

  test('percentile_cont is interpolated from a sorted json array', () => {
    const { sql } = translateQuery(
      `select percentile_cont(0.75) within group (order by lcp) as p75 from t`,
    );

    expect(sql).toContain('json_group_array(lcp order by lcp) filter (where lcp is not null)');
    expect(sql).toContain('* 0.75)');
    expect(sql).toMatch(/ as p75 from t$/);
  });

  test('mode() within group -> most frequent value via json_each', () => {
    const { sql } = translateQuery(`(mode() within group (order by h.page_w))::int as page_w`);

    expect(sql).toBe(
      'cast(((select value from json_each(json_group_array(h.page_w)) where value is not null group by value order by count(*) desc, value limit 1)) as integer) as page_w',
    );
  });

  test('regexp_replace of www prefix', () => {
    const { sql } = translateQuery(`where d != regexp_replace(hostname, '^www.', '')`);

    expect(sql).toBe(
      `where d != (case when hostname like 'www_%' then substr(hostname, 5) else hostname end)`,
    );
  });

  test('left / position / concat', () => {
    const { sql } = translateQuery(
      `select lower(left(language, 2)), position(lower(m), 'sms'), concat(prefix, 'Search')`,
    );

    expect(sql).toBe(
      `select lower(substr(language, 1, 2)), instr(lower(m), 'sms'), (coalesce(prefix, '') || coalesce('Search', ''))`,
    );
  });

  test('distinct on -> row_number', () => {
    const { sql } = translateQuery(
      `join (select distinct on (visit_id) visit_id, url_path from website_event where website_id = {{websiteId::uuid}} order by visit_id, created_at desc) x on x.visit_id = e.visit_id`,
      { websiteId: 'w' },
    );

    expect(sql).toBe(
      'join (select visit_id, url_path from (select visit_id, url_path, row_number() over (partition by visit_id order by created_at desc) as __rn from website_event where website_id = ?) where __rn = 1) x on x.visit_id = e.visit_id',
    );
  });

  test('grouping sets -> union all', () => {
    const { sql } = translateQuery(
      `select "websiteId", x, count(distinct session_id) as y from (select 1) as events group by grouping sets (("websiteId", x), ("websiteId")) order by 1, 2`,
    );

    expect(sql).toBe(
      `select "websiteId", x, count(distinct session_id) as y from (select 1) as events group by "websiteId", x union all select "websiteId", null as "x", count(distinct session_id) as y from (select 1) as events group by "websiteId" order by 1, 2`,
    );
  });

  test('date-typed params are sent as YYYY-MM-DD', () => {
    const { params } = translateQuery('where d < {{v::date}}', {
      v: new Date('2024-05-06T10:00:00Z'),
    });

    expect(params).toEqual(['2024-05-06']);
  });

  test('throws when more than 100 parameters would be bound', () => {
    const data: Record<string, string> = {};
    const clauses: string[] = [];
    for (let i = 0; i < 101; i++) {
      data[`p${i}`] = `v${i}`;
      clauses.push(`x = {{p${i}}}`);
    }

    expect(() => translateQuery(`where ${clauses.join(' or ')}`, data)).toThrow(/at most 100/);
  });
});

describe('helpers', () => {
  test('mapToCharFormat', () => {
    expect(mapToCharFormat(`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`)).toBe('%Y-%m-%dT%H:%M:%SZ');
    expect(mapToCharFormat(`'YYYY-01-01"T"HH24:00:00"Z"'`)).toBe('%Y-01-01T%H:00:00Z');
  });

  test('regexToGlob', () => {
    expect(regexToGlob('foo')).toEqual(['*foo*']);
    expect(regexToGlob('^Foo$')).toEqual(['foo']);
    expect(regexToGlob('a.c')).toEqual(['*a?c*']);
    expect(regexToGlob('^/docs/.*')).toEqual(['/docs/*']);
    expect(regexToGlob('^/docs/.+$')).toEqual(['/docs/?*']);
    expect(regexToGlob('a\\.b')).toEqual(['*a.b*']);
    expect(regexToGlob('\\.pdf$')).toEqual(['*.pdf']);
    expect(regexToGlob('^/(a|b)/c')).toEqual(['/a/c*', '/b/c*']);
    expect(regexToGlob('^/x|^/y$')).toEqual(['/x*', '/y']);
    expect(regexToGlob('colou?r')).toEqual(['*color*', '*colour*']);
    expect(regexToGlob('^/post/\\d{1,3}$')).toEqual([
      '/post/[0-9]',
      '/post/[0-9][0-9]',
      '/post/[0-9][0-9][0-9]',
    ]);
    // unbounded repetition is expanded as far as D1's 50-byte pattern limit allows
    expect(regexToGlob('^/post/\\d+$')).toHaveLength(8);
    expect(regexToGlob('^/post/\\d+$').at(-1)).toBe(`/post/${'[0-9]'.repeat(8)}`);
    expect(regexToGlob('^[A-Z][a-z]+$')[0]).toBe('[a-z][a-z]');
    expect(regexToGlob('a*b')).toContain('*b*');
    expect(regexToGlob('a*b')).toContain('*ab*');
    expect(regexToGlob('[^/]+')).toContain('*[^/]*');
    expect(regexToGlob('q=\\*')).toEqual(['*q=[*]*']);
    expect(regexToGlob('^/[?]x')).toEqual(['/[?]x*']);
    expect(regexToGlob('\\s+')).toHaveLength(8);
    expect(() => regexToGlob('a(?=b)')).toThrow(SqliteTranslateError);
    expect(() => regexToGlob('(a|b|c|d){4}')).toThrow(/too complex/);
    expect(() => regexToGlob('a^b')).toThrow(SqliteTranslateError);
    expect(() => regexToGlob('(ab')).toThrow(SqliteTranslateError);
    expect(() => regexToGlob('+a')).toThrow(SqliteTranslateError);
  });

  test('timezone offsets', () => {
    expect(getOffsetSeconds('UTC', Date.UTC(2024, 0, 1))).toBe(0);
    expect(getOffsetSeconds('America/New_York', Date.UTC(2024, 0, 15))).toBe(-5 * 3600);
    expect(getOffsetSeconds('America/New_York', Date.UTC(2024, 6, 15))).toBe(-4 * 3600);
    expect(getOffsetSeconds('Asia/Kolkata', Date.UTC(2024, 6, 15))).toBe(5.5 * 3600);

    const ny = getZoneInfo('America/New_York');
    expect(
      ny.transitions.some(t => t.at === '2024-03-10T07:00:00.000+00:00' && t.offset === -14400),
    ).toBe(true);
    expect(
      ny.transitions.some(t => t.at === '2024-11-03T06:00:00.000+00:00' && t.offset === -18000),
    ).toBe(true);

    expect(getZoneInfo('Asia/Tokyo').transitions).toEqual([]);
    expect(getLocalTimeSQL('x', 'Asia/Tokyo')).toBe(`datetime(unixepoch(x) + 32400, 'unixepoch')`);
    expect(getLocalTimeSQL('x', 'utc')).toBe('datetime(x)');
    expect(toCanonicalTimestamp(new Date('2024-01-01T00:00:00Z'))).toBe(
      '2024-01-01T00:00:00.000+00:00',
    );
  });
});

describe('raw statements with $N placeholders', () => {
  test('delete ... using becomes delete where exists', () => {
    const { sql, params } = translateUnsafe(
      `
      delete from event_data
      using website_event
      where event_data.website_event_id = website_event.event_id
        and website_event.website_id = $1
    `,
      ['w1'],
    );
    expect(sql.replace(/\s+/g, ' ').trim()).toBe(
      'delete from event_data where exists (select 1 from website_event where event_data.website_event_id = website_event.event_id and website_event.website_id = ?)',
    );
    expect(params).toEqual(['w1']);
  });

  test('repeated and out-of-order placeholders', () => {
    const { sql, params } = translateUnsafe('select $2, $1, $2', ['a', 'b']);
    expect(sql).toBe('select ?, ?, ?');
    expect(params).toEqual(['b', 'a', 'b']);
  });
});
