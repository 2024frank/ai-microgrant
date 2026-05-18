/**
 * GET /api/agent/runs
 *
 * Returns recent run history. Frontend polls this every 2s while
 * has_active is true.
 */

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/agent/runs/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN    = { id: 1, email: 'admin@oberlin.edu', role: 'admin',    full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'rev@oberlin.edu',   role: 'reviewer', full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/agent/runs');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, { headers: { Authorization: 'Bearer valid' } });
}

const COMPLETED_RUN = {
  id: 1, source_id: 1, status: 'completed', source_name: 'Apollo Theatre',
  events_found: 5, events_extracted: 4, events_skipped_dup: 1, events_errored: 0,
  elapsed_sec: 12, error_log: null,
  started_at: new Date('2026-05-01T06:00:00Z'),
  finished_at: new Date('2026-05-01T06:00:12Z'),
};

const RUNNING_RUN = { ...COMPLETED_RUN, id: 2, status: 'running', finished_at: null };

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/agent/runs', () => {
  it('returns run list with shape', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[COMPLETED_RUN]]);

    const res  = await GET(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].source_name).toBe('Apollo Theatre');
  });

  it('has_active is false when all runs are completed or failed', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[COMPLETED_RUN, { ...COMPLETED_RUN, status: 'failed' }]]);

    const data = await (await GET(makeReq())).json();
    expect(data.has_active).toBe(false);
  });

  it('has_active is true when any run is in running status', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[COMPLETED_RUN, RUNNING_RUN]]);

    const data = await (await GET(makeReq())).json();
    expect(data.has_active).toBe(true);
  });

  it('filters by source_id when provided', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[COMPLETED_RUN]]);

    await GET(makeReq({ source_id: '1' }));

    const query = db.default.query.mock.calls[1][0];
    expect(query).toContain('ar.source_id = ?');
  });

  it('default limit is 10', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]]);

    await GET(makeReq());

    const params = db.default.query.mock.calls[1][1];
    expect(params[params.length - 1]).toBe(10);
  });

  it('respects custom limit', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]]);

    await GET(makeReq({ limit: '5' }));

    const params = db.default.query.mock.calls[1][1];
    expect(params[params.length - 1]).toBe(5);
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await GET(makeReq())).status).toBe(403);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await GET(new NextRequest('http://localhost/api/agent/runs', {}))).status).toBe(401);
  });
});
