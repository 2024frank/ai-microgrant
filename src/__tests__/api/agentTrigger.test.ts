/**
 * POST /api/agent/trigger/:source_id
 *
 * Fires the agent in background and returns run_id immediately.
 * All actual agent work is tested in agentRunner.test.ts.
 */

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn().mockResolvedValue({ run_id: 5, inserted: 3 }),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agent/trigger/[source_id]/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN    = { id: 1, email: 'admin@oberlin.edu', role: 'admin',    full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'rev@oberlin.edu',   role: 'reviewer', full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };
const SOURCE   = { id: 3, name: 'Apollo Theatre' };

function ctx(source_id: string) {
  return { params: Promise.resolve({ source_id }) };
}

function makeReq() {
  return new NextRequest('http://localhost/api/agent/trigger/3', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid' },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('POST /api/agent/trigger/:source_id', () => {
  it('returns 200 with run_id immediately (does not await agent)', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])           // getAuthUser
      .mockResolvedValueOnce([[SOURCE]])          // source lookup
      .mockResolvedValueOnce([{ insertId: 7 }]); // INSERT agent_runs

    const res  = await POST(makeReq(), ctx('3'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.run_id).toBe(7);
    expect(data.source).toBe('Apollo Theatre');
    expect(data.message).toContain('poll');
  });

  it('returns 404 when source is inactive or does not exist', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]]); // source not found

    const res = await POST(makeReq(), ctx('99'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('Source not found');
  });

  it('returns 403 for reviewer role', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);

    const res = await POST(makeReq(), ctx('3'));
    expect(res.status).toBe(403);
  });

  it('returns 401 with no token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    const res = await POST(
      new NextRequest('http://localhost/api/agent/trigger/3', { method: 'POST' }),
      ctx('3')
    );
    expect(res.status).toBe(401);
  });

  it('opens a running agent_run record before returning', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ insertId: 7 }]);

    await POST(makeReq(), ctx('3'));

    const insertCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO agent_runs')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain('"running"');
  });
});
