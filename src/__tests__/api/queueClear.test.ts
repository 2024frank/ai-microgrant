import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agent/queue-clear/route';

const db = require('@/lib/db');

function makeReq(secret = 'test-cron-secret', confirm = 'pending') {
  const query = confirm ? `?confirm=${confirm}` : '';
  return new NextRequest(`http://localhost/api/agent/queue-clear${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  db.default.getConnection.mockClear().mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset().mockResolvedValue([{ affectedRows: 0 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
});

describe('POST /api/agent/queue-clear', () => {
  it('rejects requests without the cron secret', async () => {
    expect((await POST(makeReq('wrong'))).status).toBe(401);
  });

  it('refuses to run without the explicit confirm parameter', async () => {
    const response = await POST(makeReq('test-cron-secret', ''));
    expect(response.status).toBe(400);
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('archives per-source counts and deletes only plain pending drafts', async () => {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('GROUP BY')) {
        return Promise.resolve([[{ source_id: 7, source_name: 'Oberlin Public Library', total: 12 }]]);
      }
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM raw_events')) {
        return Promise.resolve([{ affectedRows: 12 }]);
      }
      return Promise.resolve([{ affectedRows: 0 }]);
    });

    const data = await (await POST(makeReq())).json();

    expect(data.ok).toBe(true);
    expect(data.deleted_pending).toBe(12);
    const archive = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('event_stats_archive'),
    );
    expect(archive![1]).toEqual([7, 'Oberlin Public Library', 12]);
    const wipe = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.startsWith('DELETE FROM raw_events'),
    );
    // Only plain pending drafts: corrections in flight are excluded.
    expect(wipe![0]).toContain("status='pending'");
    expect(wipe![0]).toContain('sent_for_correction');
    expect(db.mockConn.commit).toHaveBeenCalled();
  });
});
