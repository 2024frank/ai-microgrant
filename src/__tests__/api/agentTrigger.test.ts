jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn().mockResolvedValue({ run_id: 5, inserted: 3 }),
  triggerEmailIngest: jest.fn().mockResolvedValue({ run_id: 5, inserted: 3, skipped: 0 }),
}));

import { after, NextRequest } from 'next/server';
import { POST } from '@/app/api/agent/trigger/[source_id]/route';
import { adminAuth } from '@/lib/firebase-admin';
import { triggerAgentRun, triggerEmailIngest } from '@/lib/agentRunner';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockAfter = after as jest.Mock;
const mockAgentRun = triggerAgentRun as jest.Mock;
const mockEmailRun = triggerEmailIngest as jest.Mock;

const ADMIN = {
  id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin',
};
const REVIEWER = {
  id: 2, email: 'rev@oberlin.edu', role: 'reviewer', full_name: 'Rev', active: 1, firebase_uid: 'uid-rev',
};
const SOURCE = { id: 3, name: 'Apollo Theatre', source_type: 'web' };

function ctx(source_id: string) {
  return { params: Promise.resolve({ source_id }) };
}

function manualReq() {
  return new NextRequest('http://localhost/api/agent/trigger/3', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid' },
  });
}

function cronReq(slot = '2026-07-13T10:30:00.000Z') {
  return new NextRequest('http://localhost/api/agent/trigger/3', {
    method: 'POST',
    headers: {
      'x-cron-secret': 'test-cron-secret',
      'x-schedule-slot': slot,
    },
  });
}

function mockSuccessfulClaim({ internal = false, source = SOURCE, runId = 7 } = {}) {
  if (!internal) db.default.query.mockResolvedValueOnce([[ADMIN]]); // auth lookup
  db.default.query
    .mockResolvedValueOnce([[source]])
    .mockResolvedValueOnce([{ affectedRows: 0 }])
    .mockResolvedValueOnce([{ affectedRows: 0 }])
    .mockResolvedValueOnce([{ insertId: runId }]);
}

describe('POST /api/agent/trigger/:source_id', () => {
  const callbacks: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.SOURCE_BUILDER_ENVIRONMENT_ID = 'env-test';
    db.default.query.mockReset();
    mockVerify.mockReset().mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
    mockAgentRun.mockReset().mockResolvedValue({ run_id: 7, inserted: 3 });
    mockEmailRun.mockReset().mockResolvedValue({ run_id: 7, inserted: 3, skipped: 0 });
    callbacks.length = 0;
    mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
      callbacks.push(callback);
    });
  });

  it('preserves manual admin triggers and schedules bounded work with after()', async () => {
    mockSuccessfulClaim();

    const response = await POST(manualReq(), ctx('3'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ ok: true, run_id: 7, scheduled: false, schedule_slot: null });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockAgentRun).not.toHaveBeenCalled();

    await callbacks[0]();
    expect(mockAgentRun).toHaveBeenCalledWith(3, 7, 'test-key', 'env-test');
  });

  it('accepts the nonempty internal secret and records the UTC schedule slot', async () => {
    mockSuccessfulClaim({ internal: true });

    const response = await POST(cronReq(), ctx('3'));
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data).toMatchObject({
      ok: true,
      scheduled: true,
      schedule_slot: '2026-07-13T10:30:00.000Z',
    });
    const insert = db.default.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO agent_runs'),
    );
    expect(insert?.[1]).toEqual([3, '2026-07-13 10:30:00']);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('does not authorize an internal request when the configured secret is empty', async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(cronReq(), ctx('3'));
    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('requires an aligned schedule slot for internal requests', async () => {
    const request = new NextRequest('http://localhost/api/agent/trigger/3', {
      method: 'POST',
      headers: { 'x-cron-secret': 'test-cron-secret' },
    });
    expect((await POST(request, ctx('3'))).status).toBe(400);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('returns 409 when the database lease rejects a running or same-slot duplicate', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce([[{ id: 19, status: 'running', schedule_slot: '2026-07-13 10:30:00' }]]);

    const response = await POST(cronReq(), ctx('3'));
    const data = await response.json();
    expect(response.status).toBe(409);
    expect(data).toMatchObject({ duplicate: true, reason: 'source_already_running', run_id: 19 });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('runs email sources through the email worker inside after()', async () => {
    mockSuccessfulClaim({ source: { ...SOURCE, source_type: 'email' } });
    await POST(manualReq(), ctx('3'));
    await callbacks[0]();
    expect(mockEmailRun).toHaveBeenCalledWith(3, 7);
    expect(mockAgentRun).not.toHaveBeenCalled();
  });

  it('restores orphaned correction state before starting a manual run', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 12 }]);

    const response = await POST(manualReq(), ctx('3'));

    expect(response.status).toBe(200);
    expect(db.default.query.mock.calls[3][0]).toContain("re.status='pending_fix'");
    expect(db.default.query.mock.calls[4][0]).toContain('DELETE nf FROM needs_fix');
    expect(db.default.query.mock.calls[4][1]).toEqual([3]);
  });

  it('persists an after() worker failure without overriding a stopped run', async () => {
    mockSuccessfulClaim();
    db.default.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    mockAgentRun.mockRejectedValueOnce(new Error('agent unavailable'));

    await POST(manualReq(), ctx('3'));
    await callbacks[0]();

    const failureUpdate = db.default.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("WHERE id=? AND status='running'"),
    );
    expect(failureUpdate?.[1]).toEqual([JSON.stringify(['agent unavailable']), 7]);
  });

  it('returns 403 for reviewer role', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await POST(manualReq(), ctx('3'))).status).toBe(403);
  });

  it('returns 400 for a malformed source id', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    expect((await POST(manualReq(), ctx('3x'))).status).toBe(400);
  });

  it('returns 404 when the source is inactive or absent', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]]);
    expect((await POST(manualReq(), ctx('99'))).status).toBe(404);
  });
});
