import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/cleanup/route';

const db = require('@/lib/db');

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cleanup', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

describe('POST /api/cleanup', () => {
  beforeEach(() => {
    db.default.query.mockReset();
    db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
    db.mockConn.query.mockReset();
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release = jest.fn();
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('rejects an incorrect secret', async () => {
    const response = await POST(request('wrong'));

    expect(response.status).toBe(401);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('preserves reviewed events and deletes only abandoned pending drafts', async () => {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('GET_LOCK')) return Promise.resolve([[{ acquired: 1 }]]);
      if (sql.includes('INSERT INTO event_stats_archive')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('DELETE re FROM raw_events')) return Promise.resolve([{ affectedRows: 2 }]);
      if (sql.includes('UPDATE raw_events')) return Promise.resolve([{ affectedRows: 3 }]);
      if (sql.includes('DELETE ar FROM agent_runs')) return Promise.resolve([{ affectedRows: 4 }]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request('test-cron-secret'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      deleted_past_events: 2,
      purged_poster_blobs: 3,
      purged_outbox_blobs: 1,
      deleted_old_runs: 4,
    }));

    const deleteEvents = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('DELETE re FROM raw_events'),
    );
    expect(deleteEvents?.[0]).toContain("status = 'pending'");
    expect(deleteEvents?.[0]).toContain('INTERVAL 90 DAY');
    expect(deleteEvents?.[0]).not.toContain("status IN ('approved'");
    expect(deleteEvents?.[0]).toContain('field_edit_log');
    expect(deleteEvents?.[0]).toContain('rejection_log');
    expect(deleteEvents?.[0]).toContain('review_sessions');
    expect(deleteEvents?.[0]).toContain('needs_fix');
    expect(deleteEvents?.[0]).toContain('communityhub_submissions');

    const deleteRuns = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('DELETE ar FROM agent_runs'),
    );
    expect(deleteRuns?.[0]).toContain('NOT EXISTS');

    const purgePosters = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('SET image_data = NULL'),
    );
    expect(purgePosters?.[0]).toContain("CONCAT('%/api/events/', id, '/poster.jpg%')");

    const purgeOutbox = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('UPDATE communityhub_updates'),
    );
    expect(purgeOutbox?.[0]).toContain("status IN ('succeeded','failed')");
  });

  it('deletes pending drafts whose approval deadline (last session end) has passed', async () => {
    db.mockConn.query.mockImplementation((sql: string) => (
      sql.includes('GET_LOCK')
        ? Promise.resolve([[{ acquired: 1 }]])
        : Promise.resolve([{ affectedRows: 0 }])
    ));

    await POST(request('test-cron-secret'));

    const deleteEvents = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('DELETE re FROM raw_events'),
    );
    // Expired drafts go at the deadline; only sessionless drafts keep the
    // 90-day grace period.
    expect(deleteEvents?.[0]).toMatch(/MAX\(CAST\(jt\.endTime AS UNSIGNED\)\)/);
    expect(deleteEvents?.[0]).toMatch(/JSON_LENGTH\(re\.sessions\) = 0\)\s*\n?\s*AND re\.created_at < DATE_SUB\(NOW\(\), INTERVAL 90 DAY\)/);
  });

  it('accepts Vercel Cron GET requests with a bearer secret and rejects others', async () => {
    db.mockConn.query.mockImplementation((sql: string) => (
      sql.includes('GET_LOCK')
        ? Promise.resolve([[{ acquired: 1 }]])
        : Promise.resolve([{ affectedRows: 0 }])
    ));

    const denied = await GET(new NextRequest('http://localhost/api/cleanup'));
    expect(denied.status).toBe(401);

    const allowed = await GET(new NextRequest('http://localhost/api/cleanup', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }));
    expect(allowed.status).toBe(200);
  });
});
