import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/sources/route';
import { adminAuth } from '@/lib/firebase-admin';

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn().mockResolvedValue({ run_id: 1, inserted: 0 }),
}));

const db          = require('@/lib/db');
const mockVerify  = adminAuth.verifyIdToken as jest.Mock;

const ADMIN    = { id: 1, email: 'admin@oberlin.edu', role: 'admin',    full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'rev@oberlin.edu',   role: 'reviewer', full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };

function req(method = 'GET', body?: any) {
  return new NextRequest('http://localhost/api/sources', {
    method,
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/sources', () => {
  it('returns evidence-backed schedule, run, error, and validation state', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        {
          id: 1,
          name: 'Oberlin College',
          agent_id: 'agt_123',
          active: 1,
          schedule_cron: '0 6 * * *',
        },
      ]])
      .mockResolvedValueOnce([[
        { total_events: 20, total_approved: 12, pending_review: 3, validation_issues: 2 },
      ]])
      .mockResolvedValueOnce([[
        {
          id: 90,
          status: 'failed',
          started_at: '2026-07-13T10:00:00.000Z',
          finished_at: '2026-07-13T10:01:00.000Z',
          events_found: 0,
          events_extracted: 0,
          events_skipped_dup: 0,
          events_errored: 1,
          error_log: JSON.stringify(['Provider timed out']),
          elapsed_sec: 60,
        },
      ]]);
    const data = await (await GET(req())).json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      schedule_valid: true,
      schedule_timezone: 'America/New_York',
      health_status: 'last_run_failed',
      last_run_status: 'failed',
      last_error: 'Provider timed out',
      validation_issues: 2,
    });
    expect(data[0].next_run_at).toEqual(expect.any(String));
    expect(data[0].recent_runs[0]).toMatchObject({
      id: 90,
      error_summary: 'Provider timed out',
    });
    expect(data[0].recent_runs[0]).not.toHaveProperty('error_log');
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await GET(new NextRequest('http://localhost/api/sources', {}))).status).toBe(401);
  });

  it('returns only minimal assignment-scoped source options to reviewers', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[
        { id: 2, name: 'Assigned Calendar' },
      ]]);

    const data = await (await GET(req())).json();

    expect(data).toEqual([{ id: 2, name: 'Assigned Calendar' }]);
    const sourceQuery = db.default.query.mock.calls[1];
    expect(sourceQuery[0]).toContain('reviewer_sources');
    expect(sourceQuery[1]).toEqual(['uid-rev', 'uid-rev']);
  });
});

describe('POST /api/sources', () => {
  it('creates source and triggers first fetch', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])                   // agent_id unique check → not found
      .mockResolvedValueOnce([[]])                   // slug unique check → not found
      .mockResolvedValueOnce([{ insertId: 5 }])     // INSERT
      .mockResolvedValueOnce([[{ id: 5, name: 'Apollo Theatre', slug: 'apollo-theatre', agent_id: 'agt_new', active: 1 }]]);

    const res  = await POST(req('POST', { name: 'Apollo Theatre', agent_id: 'agt_new' }));
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.name).toBe('Apollo Theatre');
    expect(data.initial_fetch).toBe('pending');
  });

  it('returns 409 for duplicate agent_id', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ id: 3 }]]);         // agent_id exists
    const res = await POST(req('POST', { name: 'X', agent_id: 'agt_dupe' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already assigned');
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await POST(req('POST', { name: 'X', agent_id: 'agt_x' }))).status).toBe(403);
  });

  it('returns 400 when name missing', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(req('POST', { agent_id: 'agt_x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('name');
  });

  it('returns 400 when agent_id missing', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(req('POST', { name: 'X' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('agent_id');
  });

  it('rejects an invalid schedule before creating the source', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(req('POST', {
      name: 'Bad Schedule',
      agent_id: 'agt_bad_schedule',
      schedule_cron: 'not a cron',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Invalid schedule');
    expect(db.default.query).toHaveBeenCalledTimes(1);
  });
});
