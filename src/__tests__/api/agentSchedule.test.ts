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
    db.default.query.mockResolvedValue([{ affectedRows: 0 }]);
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

  it('dispatches current and missed daily slots while failing closed on invalid schedules', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 1, name: 'Due source', schedule_cron: '30 6 * * *' },
      { id: 2, name: 'Later source', schedule_cron: '0 9 * * *' },
      { id: 3, name: 'Broken source', schedule_cron: 'not a cron' },
    ]]);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, run_id: 77 }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, run_id: 78 }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ));

    const response = await GET(makeReq());
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data).toMatchObject({ checked: 3, due: 2, dispatched: 2, failed: 0 });
    expect(data.invalid_schedules).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
    expect(global.fetch).toHaveBeenCalledWith(
      new URL('http://localhost/api/agent/trigger/2'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-cron-secret': 'test-cron-secret',
          'x-schedule-slot': '2026-07-12T13:00:00.000Z',
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

    const response = await GET(makeReq());
    const data = await response.json();
    expect(response.status).toBe(502);
    expect(data).toMatchObject({ due: 2, dispatched: 0, skipped: 1, failed: 1 });
    expect(data.results[0]).toMatchObject({ status: 'skipped', run_id: 9 });
    expect(data.results[1]).toMatchObject({ status: 'error', error: 'Unavailable' });
  });

  it('fails when a trigger returns 2xx without a durable run id', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 1, name: 'Malformed trigger', schedule_cron: '30 6 * * *' },
    ]]);
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: true }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    ));

    const response = await GET(makeReq());
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data).toMatchObject({ due: 1, dispatched: 0, failed: 1 });
    expect(data.results[0]).toMatchObject({
      status: 'error',
      reason: 'invalid_trigger_response',
    });
  });

  it('skips retry cooldowns but surfaces exhausted retries as scheduler errors', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 1, name: 'Cooling down', schedule_cron: '30 6 * * *' },
      { id: 2, name: 'Retry exhausted', schedule_cron: '45 6 * * *' },
    ]]);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          error: 'Scheduled slot retry is cooling down',
          reason: 'schedule_slot_retry_cooldown',
          attempts: 1,
          max_attempts: 3,
          retry_after_seconds: 600,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          error: 'Scheduled slot retry limit exhausted',
          reason: 'schedule_slot_retry_exhausted',
          attempts: 3,
          max_attempts: 3,
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ));

    const response = await GET(makeReq());
    const data = await response.json();
    expect(response.status).toBe(502);

    expect(data).toMatchObject({ due: 2, dispatched: 0, skipped: 1, failed: 1 });
    expect(data.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule_slot_retry_cooldown',
      attempts: 1,
      retry_after_seconds: 600,
    });
    expect(data.results[1]).toMatchObject({
      status: 'error',
      error: 'Scheduled slot retry limit exhausted',
      reason: 'schedule_slot_retry_exhausted',
      attempts: 3,
    });
  });

  it('dispatches a daily slot after a delayed GitHub scheduled invocation', async () => {
    jest.setSystemTime(new Date('2026-07-14T11:46:00Z')); // 07:46 EDT
    db.default.query.mockResolvedValueOnce([[
      { id: 4, name: 'Delayed source', schedule_cron: '0 6 * * *' },
    ]]);
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: true, run_id: 88 }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    ));

    const data = await (await GET(makeReq())).json();
    expect(data).toMatchObject({ due: 1, dispatched: 1, failed: 0 });
    expect(global.fetch).toHaveBeenCalledWith(
      new URL('http://localhost/api/agent/trigger/4'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-schedule-slot': '2026-07-14T10:00:00.000Z',
        }),
      }),
    );
  });

  it('handles an empty active-source list without dispatching', async () => {
    db.default.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const data = await (await GET(makeReq())).json();
    expect(data).toMatchObject({
      checked: 0,
      due: 0,
      dispatched: 0,
      recovered_stale_runs: 2,
      recovered_correction_requests: 1,
    });
    expect(db.default.query.mock.calls[2][0]).toContain("re.status='pending_fix'");
    expect(db.default.query.mock.calls[2][0]).toContain("re.status='rejected'");
    expect(db.default.query.mock.calls[2][0]).toContain('ar.correction_event_id=re.id');
    expect(db.default.query.mock.calls[2][0]).not.toContain('JOIN needs_fix');
    expect(db.default.query.mock.calls[3][0]).toContain('DELETE nf FROM needs_fix');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails visibly when scheduler maintenance cannot recover stale state', async () => {
    db.default.query
      .mockResolvedValueOnce([[]])
      .mockRejectedValueOnce(new Error('migration missing'))
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    const response = await GET(makeReq());
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.maintenance_errors).toEqual(['stale_run_recovery_failed']);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
