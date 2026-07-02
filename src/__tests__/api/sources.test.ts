import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/sources/route';
import { DELETE as DELETE_SOURCE } from '@/app/api/sources/[id]/route';
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

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/sources', () => {
  it('returns sources list', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        { id: 1, name: 'Oberlin College', agent_id: 'agt_123', active: 1 },
        { id: 2, name: 'Apollo Theatre',  agent_id: 'agt_456', active: 1 },
      ]]);
    const data = await (await GET(req())).json();
    expect(data).toHaveLength(2);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await GET(new NextRequest('http://localhost/api/sources', {}))).status).toBe(401);
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
});

describe('DELETE /api/sources/:id', () => {
  it('refuses to delete a source with existing events to preserve review history', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ total_events: 3 }]]);

    const res = await DELETE_SOURCE(req('DELETE'), ctx('1'));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toContain('Cannot delete');
    expect(db.default.query.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM agent_runs')
    )).toBe(false);
    expect(db.default.query.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE raw_events SET source_id = NULL')
    )).toBe(false);
  });

  it('deletes source assignments and the source when no events exist', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ total_events: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await DELETE_SOURCE(req('DELETE'), ctx('1'));

    expect(res.status).toBe(200);
    expect(db.default.query.mock.calls[2][0]).toContain('DELETE FROM reviewer_sources');
    expect(db.default.query.mock.calls[3][0]).toContain('DELETE FROM sources');
  });
});
