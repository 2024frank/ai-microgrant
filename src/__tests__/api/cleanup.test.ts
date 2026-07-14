import { NextRequest } from 'next/server';
import { POST } from '@/app/api/cleanup/route';

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
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('rejects an incorrect secret', async () => {
    const response = await POST(request('wrong'));

    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('preserves reviewed events and deletes only abandoned pending drafts', async () => {
    db.default.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 3 }])
      .mockResolvedValueOnce([{ affectedRows: 4 }]);

    const response = await POST(request('test-cron-secret'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      deleted_past_events: 2,
      purged_poster_blobs: 3,
      deleted_old_runs: 4,
    }));

    const deleteEvents = db.default.query.mock.calls.find(
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

    const deleteRuns = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('DELETE ar FROM agent_runs'),
    );
    expect(deleteRuns?.[0]).toContain('NOT EXISTS');
  });
});
