import { NextRequest } from 'next/server';
import { GET } from '@/app/api/agent/schedule/route';

const db = require('@/lib/db');

function makeReq(secret = 'test-cron-secret') {
  return new NextRequest('http://localhost/api/agent/schedule', {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

describe('GET /api/agent/schedule', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-13T11:00:00Z')); // 07:00 EDT
    process.env.CRON_SECRET = 'test-cron-secret';
    db.default.query.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it('rejects execution when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(makeReq());
    expect(response.status).toBe(503);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('returns 401 for the wrong secret', async () => {
    const response = await GET(makeReq('wrong'));
    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('dispatches only due sources and fails closed on invalid schedules', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 1, name: 'Due source', schedule_cron: '30 6 * * *' },
      { id: 2, name: 'Later source', schedule_cron: '0 9 * * *' },
      { id: 3, name: 'Broken source', schedule_cron: 'not a cron' },
    ]]);
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: true, run_id: 77 }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    ));

    const response = await GET(makeReq());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ checked: 3, due: 1, dispatched: 1, failed: 0 });
    expect(data.invalid_schedules).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      new URL('http://localhost/api/agent/trigger/1'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-cron-secret': 'test-cron-secret',
          'x-schedule-slot': '2026-07-13T10:30:00.000Z',
        }),
      }),
    );
  });

  it('reports duplicate leases as skipped and trigger failures as errors', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 1, name: 'Already running', schedule_cron: '30 6 * * *' },
      { id: 2, name: 'Trigger failure', schedule_cron: '45 6 * * *' },
    ]]);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ duplicate: true, reason: 'source_already_running', run_id: 9 }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ));

    const data = await (await GET(makeReq())).json();
    expect(data).toMatchObject({ due: 2, dispatched: 0, skipped: 1, failed: 1 });
    expect(data.results[0]).toMatchObject({ status: 'skipped', run_id: 9 });
    expect(data.results[1]).toMatchObject({ status: 'error', error: 'Unavailable' });
  });

  it('handles an empty active-source list without dispatching', async () => {
    db.default.query.mockResolvedValueOnce([[]]);
    const data = await (await GET(makeReq())).json();
    expect(data).toMatchObject({ checked: 0, due: 0, dispatched: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
