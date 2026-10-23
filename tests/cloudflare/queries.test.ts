/**
 * Runs umami's relational queries against a real local D1 database.
 *
 * This is the safety net for the Postgres -> SQLite translation: every query
 * that upstream ships is executed here with representative filters. If an
 * upstream merge introduces SQL the translator does not understand, this fails.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type D1TestContext, startD1 } from './d1';

process.env.DATABASE_URL = 'd1://DB';

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_A = '22222222-2222-4222-8222-222222222222';
const SESSION_B = '33333333-3333-4333-8333-333333333333';
const VISIT_A = '44444444-4444-4444-8444-444444444444';
const VISIT_B = '55555555-5555-4555-8555-555555555555';

const startDate = new Date('2024-03-01T00:00:00Z');
const endDate = new Date('2024-03-31T23:59:59Z');

let ctx: D1TestContext;
let sql: typeof import('@/queries/sql');
let prismaQueries: typeof import('@/queries/prisma');
// not re-exported from the index
let getWebsiteEventStats: typeof import('@/queries/sql/events/getWebsiteEventStats').getWebsiteEventStats;
let getGoal: typeof import('@/queries/sql/goals/getGoal').getGoal;
let getPerformanceMetrics: typeof import('@/queries/sql/performance/getPerformanceMetrics').getPerformanceMetrics;
let getRevenueStats: typeof import('@/queries/sql/revenue/getRevenueStats').getRevenueStats;
let getRevenueChart: typeof import('@/queries/sql/revenue/getRevenueChart').getRevenueChart;
let getPerformanceChart: typeof import('@/queries/sql/performance/getPerformanceChart').getPerformanceChart;
let getAttribution: typeof import('@/queries/sql/attribution/getAttribution').getAttribution;
let getRevenueSessions: typeof import('@/queries/sql/revenue/getRevenueSessions').getRevenueSessions;
let getRevenueMetrics: typeof import('@/queries/sql/revenue/getRevenueMetrics').getRevenueMetrics;

function filters(extra: Record<string, unknown> = {}) {
  return { startDate, endDate, timezone: 'UTC', unit: 'day', ...extra } as any;
}

async function seed() {
  const { uuid } = await import('@/lib/crypto');

  await prismaQueries.createWebsite({ id: WEBSITE_ID, name: 'Test site', domain: 'example.com' });

  await sql.createSession({
    id: SESSION_A,
    websiteId: WEBSITE_ID,
    browser: 'chrome',
    os: 'Mac OS',
    device: 'laptop',
    screen: '1440x900',
    language: 'en-US',
    country: 'US',
    region: 'US-CA',
    city: 'San Francisco',
    distinctId: 'user-a',
    createdAt: new Date('2024-03-05T10:00:00Z'),
  });

  await sql.createSession({
    id: SESSION_B,
    websiteId: WEBSITE_ID,
    browser: 'firefox',
    os: 'Windows',
    device: 'desktop',
    screen: '1920x1080',
    language: 'de-DE',
    country: 'DE',
    region: 'DE-BE',
    city: 'Berlin',
    createdAt: new Date('2024-03-10T18:30:00Z'),
  });

  const pageviews = [
    {
      sessionId: SESSION_A,
      visitId: VISIT_A,
      urlPath: '/',
      referrerDomain: 'google.com',
      createdAt: '2024-03-05T10:00:00Z',
    },
    {
      sessionId: SESSION_A,
      visitId: VISIT_A,
      urlPath: '/pricing',
      createdAt: '2024-03-05T10:02:00Z',
    },
    {
      sessionId: SESSION_A,
      visitId: VISIT_A,
      urlPath: '/signup',
      createdAt: '2024-03-05T10:05:00Z',
    },
    {
      sessionId: SESSION_B,
      visitId: VISIT_B,
      urlPath: '/',
      urlQuery: 'utm_source=newsletter&utm_medium=email',
      utmSource: 'newsletter',
      utmMedium: 'email',
      createdAt: '2024-03-10T18:30:00Z',
    },
    {
      sessionId: SESSION_B,
      visitId: VISIT_B,
      urlPath: '/blog/hello',
      pageTitle: 'Hello',
      createdAt: '2024-03-10T18:31:00Z',
    },
  ];

  for (const pv of pageviews) {
    await sql.saveEvent({
      websiteId: WEBSITE_ID,
      sessionId: pv.sessionId,
      visitId: pv.visitId,
      eventType: 1,
      createdAt: new Date(pv.createdAt),
      urlPath: pv.urlPath,
      urlQuery: pv.urlQuery,
      referrerDomain: pv.referrerDomain,
      pageTitle: pv.pageTitle,
      hostname: 'example.com',
      utmSource: pv.utmSource,
      utmMedium: pv.utmMedium,
    });
  }

  // custom event with event data, including revenue
  await sql.saveEvent({
    websiteId: WEBSITE_ID,
    sessionId: SESSION_A,
    visitId: VISIT_A,
    eventType: 2,
    createdAt: new Date('2024-03-05T10:06:00Z'),
    urlPath: '/signup',
    hostname: 'example.com',
    eventName: 'signup',
    eventData: {
      plan: 'pro',
      amount: 42.5,
      tags: ['alpha', 'beta'],
      when: new Date('2024-03-05T10:06:00Z'),
      revenue: 42.5,
      currency: 'USD',
    },
  });

  // performance event
  await sql.saveEvent({
    websiteId: WEBSITE_ID,
    sessionId: SESSION_A,
    visitId: VISIT_A,
    eventType: 5,
    createdAt: new Date('2024-03-05T10:00:05Z'),
    urlPath: '/',
    hostname: 'example.com',
    lcp: 1200,
    inp: 80,
    cls: 0.05,
    fcp: 900,
    ttfb: 200,
  });

  await sql.saveSessionData({
    websiteId: WEBSITE_ID,
    sessionId: SESSION_A,
    sessionData: {
      plan: 'pro',
      score: 7,
      labels: ['vip'],
      signedUpAt: new Date('2024-03-05T10:06:00Z'),
    },
    distinctId: 'user-a',
    createdAt: new Date('2024-03-05T10:06:00Z'),
  });

  await sql.saveSessionLink({
    websiteId: WEBSITE_ID,
    sessionId: SESSION_A,
    distinctId: 'user-a',
  } as any);

  await sql.saveHeatmapEvents([
    {
      websiteId: WEBSITE_ID,
      sessionId: SESSION_A,
      visitId: VISIT_A,
      urlPath: '/',
      eventType: 1,
      x: 10,
      y: 20,
      pageX: 10,
      pageY: 20,
      pageW: 1440,
      viewportW: 1440,
      viewportH: 900,
      pageH: 3000,
      scrollPct: 60,
      createdAt: new Date('2024-03-05T10:00:10Z'),
    },
  ]);

  await sql.saveRecording({
    websiteId: WEBSITE_ID,
    sessionId: SESSION_A,
    visitId: VISIT_A,
    chunkIndex: 0,
    events: [{ type: 4, data: {}, timestamp: 1709632800000 }],
    eventCount: 1,
    startedAt: new Date('2024-03-05T10:00:00Z'),
    endedAt: new Date('2024-03-05T10:05:00Z'),
  });

  void uuid;
}

beforeAll(async () => {
  ctx = await startD1();
  sql = await import('@/queries/sql');
  prismaQueries = await import('@/queries/prisma');
  ({ getWebsiteEventStats } = await import('@/queries/sql/events/getWebsiteEventStats'));
  ({ getGoal } = await import('@/queries/sql/goals/getGoal'));
  ({ getPerformanceMetrics } = await import('@/queries/sql/performance/getPerformanceMetrics'));
  ({ getRevenueStats } = await import('@/queries/sql/revenue/getRevenueStats'));
  ({ getRevenueChart } = await import('@/queries/sql/revenue/getRevenueChart'));
  ({ getPerformanceChart } = await import('@/queries/sql/performance/getPerformanceChart'));
  ({ getAttribution } = await import('@/queries/sql/attribution/getAttribution'));
  ({ getRevenueSessions } = await import('@/queries/sql/revenue/getRevenueSessions'));
  ({ getRevenueMetrics } = await import('@/queries/sql/revenue/getRevenueMetrics'));
  await seed();
});

afterAll(async () => {
  await ctx?.dispose();
});

describe('stats', () => {
  test('getWebsiteStats', async () => {
    const stats: any = await sql.getWebsiteStats(WEBSITE_ID, filters());
    expect(Number(stats.pageviews)).toBe(5);
    expect(Number(stats.visitors)).toBe(2);
    expect(Number(stats.visits)).toBe(2);
    expect(Number(stats.totaltime)).toBe(300 + 60);
  });

  test('getWebsiteStats with session filter and exclude bounce', async () => {
    const stats: any = await sql.getWebsiteStats(
      WEBSITE_ID,
      filters({ browser: 'chrome', excludeBounce: true }),
    );
    expect(Number(stats.pageviews)).toBe(3);
  });

  test('getPageviewStats buckets in UTC and in a timezone', async () => {
    const utc: any[] = await sql.getPageviewStats(WEBSITE_ID, filters());
    expect(utc.map(r => new Date(r.x).toISOString()).sort()).toEqual([
      '2024-03-05T00:00:00.000Z',
      '2024-03-10T00:00:00.000Z',
    ]);

    const la: any[] = await sql.getPageviewStats(
      WEBSITE_ID,
      filters({ timezone: 'America/Los_Angeles', unit: 'hour' }),
    );
    // 2024-03-05T10:00Z is 02:00 PST (-8); 2024-03-10T18:30Z is 11:30 PDT (-7, DST started 10 Mar 10:00Z)
    expect(la.map(r => new Date(r.x).toISOString()).sort()).toEqual([
      '2024-03-05T02:00:00.000Z',
      '2024-03-10T11:00:00.000Z',
    ]);
  });

  test.each([
    ['getSessionStats', () => sql.getSessionStats(WEBSITE_ID, filters())],
    ['getWebsiteSessionStats', () => sql.getWebsiteSessionStats(WEBSITE_ID, filters())],
    ['getWebsiteEventStats', () => getWebsiteEventStats(WEBSITE_ID, filters())],
    ['getEventDataStats', () => sql.getEventDataStats(WEBSITE_ID, filters())],
    ['getWebsiteDateRange', () => sql.getWebsiteDateRange(WEBSITE_ID)],
    ['getActiveVisitors', () => sql.getActiveVisitors(WEBSITE_ID)],
    ['getWeeklyTraffic', () => sql.getWeeklyTraffic(WEBSITE_ID, filters())],
    [
      'getRealtimeData',
      () =>
        sql.getRealtimeData(WEBSITE_ID, filters({ startDate: new Date('2024-03-05T09:00:00Z') })),
    ],
    ['getRealtimeActivity', () => sql.getRealtimeActivity(WEBSITE_ID, filters())],
    [
      'getWebsiteListCharts',
      () =>
        sql.getWebsiteListCharts([WEBSITE_ID], { startDate, endDate, timezone: 'Europe/Berlin' }),
    ],
    [
      'getWebsiteListCharts utc',
      () => sql.getWebsiteListCharts([WEBSITE_ID], { startDate, endDate, timezone: 'UTC' }),
    ],
  ])('%s', async (_name, run) => {
    await expect(run()).resolves.toBeDefined();
  });
});

describe('metrics', () => {
  test.each(['path', 'entry', 'exit', 'referrer', 'title', 'query', 'hostname', 'fullPath'])(
    'getPageviewMetrics %s',
    async type => {
      const rows: any[] = await sql.getPageviewMetrics(WEBSITE_ID, { type, limit: 10 }, filters());
      expect(Array.isArray(rows)).toBe(true);
      if (type === 'entry') expect(rows.map(r => [r.x, Number(r.y)])).toEqual([['/', 2]]);
      if (type === 'exit') expect(rows.map(r => r.x).sort()).toEqual(['/blog/hello', '/signup']);
    },
  );

  test.each(['browser', 'os', 'device', 'screen', 'language', 'country', 'region', 'city'])(
    'getSessionMetrics %s',
    async type => {
      const rows: any[] = await sql.getSessionMetrics(WEBSITE_ID, { type, limit: 10 }, filters());
      expect(rows.length).toBeGreaterThan(0);
    },
  );

  test.each(['event', 'path', 'browser'])('getEventMetrics %s', async type => {
    await expect(sql.getEventMetrics(WEBSITE_ID, { type }, filters())).resolves.toBeDefined();
  });

  test.each(['path', 'referrer', 'browser', 'country'])('expanded metrics %s', async type => {
    await expect(
      sql.getPageviewExpandedMetrics(WEBSITE_ID, { type, limit: 10 }, filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getSessionExpandedMetrics(WEBSITE_ID, { type, limit: 10 }, filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getEventExpandedMetrics(WEBSITE_ID, { type }, filters()),
    ).resolves.toBeDefined();
  });

  test('metrics with filters (search, path, referrer, cohort, property filters)', async () => {
    const rows: any[] = await sql.getPageviewMetrics(
      WEBSITE_ID,
      { type: 'path' },
      filters({ search: 'pric', referrer: 'google.com', path: '/pricing', match: 'any' }),
    );
    expect(Array.isArray(rows)).toBe(true);

    await expect(
      sql.getWebsiteStats(
        WEBSITE_ID,
        filters({
          eventPropertyFilters: [
            { propertyName: 'plan', dataType: 1, operator: 'eq', value: 'pro' },
            { propertyName: 'amount', dataType: 2, operator: 'gt', value: '10' },
            { propertyName: 'tags', dataType: 5, operator: 'c', value: 'alpha' },
            { propertyName: 'when', dataType: 4, operator: 'af', value: '2024-01-01' },
          ],
          sessionPropertyFilters: [
            { propertyName: 'plan', dataType: 1, operator: 'c', value: 'pr' },
          ],
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      sql.getWebsiteStats(
        WEBSITE_ID,
        filters({
          cohort_startDate: startDate,
          cohort_endDate: endDate,
          cohort_path: '/',
          cohort_match: 'any',
        } as any),
      ),
    ).resolves.toBeDefined();
  });

  test('channel / utm / values', async () => {
    const channels: any[] = await sql.getChannelMetrics(WEBSITE_ID, filters());
    expect(channels.length).toBeGreaterThan(0);
    await expect(sql.getChannelExpandedMetrics(WEBSITE_ID, filters())).resolves.toBeDefined();
    await expect(
      sql.getUTM(WEBSITE_ID, { column: 'utm_source', startDate, endDate }, filters()),
    ).resolves.toBeDefined();
    const values: any[] = await sql.getValues(WEBSITE_ID, 'url_path', filters({ search: 'pri' }));
    expect(values.length).toBeGreaterThan(0);
    await expect(sql.getValues(WEBSITE_ID, 'referrer_domain', filters())).resolves.toBeDefined();
    await expect(sql.getValues(WEBSITE_ID, 'browser', filters())).resolves.toBeDefined();
  });
});

describe('reports', () => {
  test('retention', async () => {
    const rows: any[] = await sql.getRetention(
      WEBSITE_ID,
      { startDate, endDate, timezone: 'UTC' },
      filters(),
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      sql.getRetention(WEBSITE_ID, { startDate, endDate, timezone: 'Europe/Berlin' }, filters()),
    ).resolves.toBeDefined();
  });

  test('funnel', async () => {
    const rows: any[] = await sql.getFunnel(
      WEBSITE_ID,
      {
        startDate,
        endDate,
        window: 60,
        steps: [
          { type: 'path', value: '/' },
          { type: 'path', value: '/pricing' },
          { type: 'event', value: 'signup' },
        ],
      },
      filters(),
    );
    expect(rows.length).toBe(3);
    expect(Number(rows[0].visitors)).toBe(2);
    expect(Number(rows[1].visitors)).toBe(1);
  });

  test('journey', async () => {
    const rows: any[] = await sql.getJourney(
      WEBSITE_ID,
      { startDate, endDate, steps: 3, startStep: '/' },
      filters(),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  test('goal / attribution / breakdown', async () => {
    await expect(
      getGoal(WEBSITE_ID, { startDate, endDate, type: 'path', value: '/pricing' }, filters()),
    ).resolves.toBeDefined();
    await expect(
      getGoal(WEBSITE_ID, { startDate, endDate, type: 'event', value: 'signup' }, filters()),
    ).resolves.toBeDefined();
    for (const model of ['first-click', 'last-click']) {
      await expect(
        getAttribution(
          WEBSITE_ID,
          { startDate, endDate, model, type: 'path', step: '/signup' },
          filters(),
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      sql.getBreakdown(
        WEBSITE_ID,
        { startDate, endDate, fields: ['browser', 'country', 'path'] },
        filters(),
      ),
    ).resolves.toBeDefined();
  });

  test('performance', async () => {
    const params = { startDate, endDate, unit: 'day', timezone: 'UTC', metric: 'lcp' };
    const stats: any = await sql.getPerformanceStats(WEBSITE_ID, params, filters());
    expect(stats).toBeDefined();
    await expect(
      getPerformanceMetrics(WEBSITE_ID, params, filters(), 'url_path', 10),
    ).resolves.toBeDefined();
    await expect(getPerformanceChart(WEBSITE_ID, params, filters())).resolves.toBeDefined();
  });

  test('revenue', async () => {
    const params = { startDate, endDate, unit: 'day', timezone: 'UTC', currency: 'USD' };
    await expect(getRevenueStats(WEBSITE_ID, params, filters())).resolves.toBeDefined();
    await expect(getRevenueChart(WEBSITE_ID, params, filters())).resolves.toBeDefined();
    await expect(
      getRevenueSessions(WEBSITE_ID, 'USD', filters({ pageSize: 10 })),
    ).resolves.toBeDefined();
    for (const type of ['country', 'region', 'referrer', 'channel'] as const) {
      await expect(getRevenueMetrics(WEBSITE_ID, params, filters(), type)).resolves.toBeDefined();
    }
  });

  test('heatmap', async () => {
    await expect(
      sql.getHeatmap(WEBSITE_ID, { ...filters(), urlPath: '/', mode: 'click' }),
    ).resolves.toBeDefined();
    await expect(
      sql.getHeatmap(WEBSITE_ID, { ...filters(), urlPath: '/', mode: 'scroll' }),
    ).resolves.toBeDefined();
  });
});

describe('event & session data', () => {
  test('event data', async () => {
    await expect(sql.getEventDataFields(WEBSITE_ID, 'signup', filters())).resolves.toBeDefined();
    await expect(sql.getEventDataProperties(WEBSITE_ID, filters())).resolves.toBeDefined();
    await expect(sql.getEventDataEvents(WEBSITE_ID, filters())).resolves.toBeDefined();

    const values: any[] = await sql.getEventDataValues(
      WEBSITE_ID,
      'signup',
      filters({ propertyName: 'tags', dataType: 5 }),
    );
    expect(values.map(v => v.value).sort()).toEqual(['alpha', 'beta']);

    await expect(
      sql.getEventDataValues(WEBSITE_ID, 'signup', filters({ propertyName: 'when', dataType: 4 })),
    ).resolves.toBeDefined();

    const stats: any = await sql.getEventDataNumericStats(
      WEBSITE_ID,
      'signup',
      'amount',
      filters(),
    );
    expect(Number(stats.median)).toBeCloseTo(42.5);

    await expect(
      sql.getEventDataNumericSeries(WEBSITE_ID, 'signup', 'amount', 'sum', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getEventDataArraySeries(WEBSITE_ID, 'signup', 'tags', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getEventDataDateSeries(WEBSITE_ID, 'signup', 'when', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getEventDataPropertySeries(WEBSITE_ID, 'signup', 'plan', filters()),
    ).resolves.toBeDefined();

    const pivot: any = await sql.getEventDataPivot(WEBSITE_ID, 'signup', filters());
    expect(pivot.data.length).toBe(1);
    expect(pivot.data[0].propertyKeys).toContain('plan');
    expect(Array.isArray(pivot.data[0].propertyValues)).toBe(true);
  });

  test('session data', async () => {
    await expect(sql.getSessionDataProperties(WEBSITE_ID, filters())).resolves.toBeDefined();
    const values: any[] = await sql.getSessionDataValues(
      WEBSITE_ID,
      filters({ propertyName: 'labels', dataType: 5 }),
    );
    expect(values.map(v => v.value)).toEqual(['vip']);
    const stats: any = await sql.getSessionDataNumericStats(WEBSITE_ID, 'score', filters());
    expect(Number(stats.median)).toBe(7);
    await expect(
      sql.getSessionDataNumericSeries(WEBSITE_ID, 'score', 'avg', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getSessionDataArraySeries(WEBSITE_ID, 'labels', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getSessionDataDateSeries(WEBSITE_ID, 'signedUpAt', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getSessionDataPropertySeries(WEBSITE_ID, 'plan', filters()),
    ).resolves.toBeDefined();
    await expect(
      sql.getSessionDataActivityStats(WEBSITE_ID, 'plan', filters()),
    ).resolves.toBeDefined();

    const pivot: any = await sql.getSessionDataPivot(WEBSITE_ID, 'plan', filters());
    expect(pivot.data.length).toBe(1);
    expect(pivot.data[0].propertyKeys).toContain('plan');
  });

  test('sessions', async () => {
    const sessions: any = await sql.getWebsiteSessions(WEBSITE_ID, filters({ pageSize: 10 }));
    expect(sessions.count).toBe(2);
    const session: any = await sql.getWebsiteSession(WEBSITE_ID, SESSION_A);
    expect(session?.id ?? session?.sessionId ?? session).toBeTruthy();
    await expect(sql.getSessionActivity(WEBSITE_ID, [SESSION_A], filters())).resolves.toBeDefined();
    await expect(sql.getSessionData(WEBSITE_ID, SESSION_A)).resolves.toBeDefined();
    await expect(sql.getLinkedSessionIds(WEBSITE_ID, 'user-a')).resolves.toBeDefined();
    await expect(sql.getLinkedDistinctIds(WEBSITE_ID, SESSION_A)).resolves.toBeDefined();
    await expect(
      sql.getWebsiteEvents(WEBSITE_ID, filters({ pageSize: 10 })),
    ).resolves.toBeDefined();
    await expect(sql.getEventStats(WEBSITE_ID, { limit: 10 }, filters())).resolves.toBeDefined();
  });

  test('replays', async () => {
    // session_replay.created_at defaults to insert time, so search up to now
    const replays: any = await sql.getSessionReplays(
      WEBSITE_ID,
      filters({ pageSize: 10, search: 'chrome', endDate: new Date() }),
    );
    expect(replays.count).toBe(1);
    await expect(sql.getReplayChunks(WEBSITE_ID, VISIT_A)).resolves.toBeDefined();
  });
});

describe('prisma ORM on D1', () => {
  test('crud through generated client', async () => {
    const website = await prismaQueries.getWebsite(WEBSITE_ID);
    expect(website?.name).toBe('Test site');
    const updated = await prismaQueries.updateWebsite(WEBSITE_ID, { name: 'Renamed' } as any);
    expect(updated.name).toBe('Renamed');
    const list: any = await prismaQueries.getWebsites({} as any, { pageSize: 10 } as any);
    expect(list.count).toBeGreaterThanOrEqual(1);
  });
});
