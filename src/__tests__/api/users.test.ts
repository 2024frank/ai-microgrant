/**
 * Users API — GET /api/users, POST /api/users/invite, PATCH /api/users/:id
 *
 * Email delivery and Next's deferred lifecycle are mocked so no real email is sent.
 */

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

jest.mock('@/lib/email', () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
}));

import { after, NextRequest } from 'next/server';
import { GET } from '@/app/api/users/route';
import { POST } from '@/app/api/users/invite/route';
import { PATCH } from '@/app/api/users/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';
import { sendWelcomeEmail } from '@/lib/email';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockAfter = after as jest.Mock;
const mockSendWelcomeEmail = sendWelcomeEmail as jest.Mock;
const afterCallbacks: Array<() => Promise<void> | void> = [];

const ADMIN    = { id: 1, email: 'admin@oberlin.edu', role: 'admin',    full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'rev@oberlin.edu',   role: 'reviewer', full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };

function makeReq(method: string, body?: any, path = '/api/users') {
  return new NextRequest(`http://localhost${path}`, {
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
  mockSendWelcomeEmail.mockReset().mockResolvedValue(undefined);
  afterCallbacks.length = 0;
  mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  });
});

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------
describe('GET /api/users', () => {
  it('returns user list for admin', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        { id: 1, email: 'admin@oberlin.edu', full_name: 'Admin', role: 'admin',    active: 1, assigned_sources: null },
        { id: 2, email: 'rev@oberlin.edu',   full_name: 'Rev',   role: 'reviewer', active: 1, assigned_sources: null },
      ]]);

    const res  = await GET(makeReq('GET'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(2);
    expect(data[0].role).toBe('admin');
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await GET(makeReq('GET'))).status).toBe(403);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await GET(new NextRequest('http://localhost/api/users', {}))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/users/invite
// ---------------------------------------------------------------------------
describe('POST /api/users/invite', () => {
  it('creates a new reviewer and returns 201', async () => {
    const newUser = { id: 5, email: 'jane@oberlin.edu', full_name: 'Jane Smith', role: 'reviewer', active: 1 };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])               // auth
      .mockResolvedValueOnce([[]])                    // existing email check → not found
      .mockResolvedValueOnce([{ insertId: 5 }])       // INSERT users
      .mockResolvedValueOnce([[{ pendingCount: 0 }]]) // pendingCount for welcome email
      .mockResolvedValueOnce([[newUser]]);             // SELECT created user

    const res  = await POST(makeReq('POST', { email: 'jane@oberlin.edu', full_name: 'Jane Smith', role: 'reviewer' }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.email).toBe('jane@oberlin.edu');
    expect(data.role).toBe('reviewer');
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockSendWelcomeEmail).not.toHaveBeenCalled();

    await afterCallbacks[0]();

    expect(mockSendWelcomeEmail).toHaveBeenCalledWith({
      email: 'jane@oberlin.edu',
      name: 'Jane Smith',
      role: 'reviewer',
      pendingCount: 0,
    });
  });

  it('lowercases and trims the email on insert', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([[{ pendingCount: 0 }]])
      .mockResolvedValueOnce([[{ id: 5, email: 'jane@oberlin.edu', full_name: 'Jane', role: 'reviewer', active: 1 }]]);

    await POST(makeReq('POST', { email: '  JANE@Oberlin.EDU  ', full_name: 'Jane' }));

    const insertCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO users')
    );
    expect(insertCall[1][0]).toBe('jane@oberlin.edu');
  });

  it('assigns source_ids when provided', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 6 }])
      .mockResolvedValueOnce([[]])                    // INSERT reviewer_sources
      .mockResolvedValueOnce([[{ pendingCount: 0 }]]) // pendingCount for welcome email
      .mockResolvedValueOnce([[{ id: 6, email: 'x@o.edu', full_name: 'X', role: 'reviewer', active: 1 }]]);

    await POST(makeReq('POST', { email: 'x@o.edu', full_name: 'X', source_ids: [1, 2] }));

    const sourceInsert = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('reviewer_sources')
    );
    expect(sourceInsert).toBeDefined();
  });

  it('returns 409 when email already registered', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ id: 3 }]]); // existing user found

    const res = await POST(makeReq('POST', { email: 'admin@oberlin.edu', full_name: 'Dupe' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already registered');
  });

  it('returns 400 when email missing', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(makeReq('POST', { full_name: 'No Email' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('email');
  });

  it('returns 400 when full_name missing', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(makeReq('POST', { email: 'x@o.edu' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('full_name');
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    const res = await POST(makeReq('POST', { email: 'x@o.edu', full_name: 'X' }));
    expect(res.status).toBe(403);
  });

  it('defaults role to reviewer when not specified', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 7 }])
      .mockResolvedValueOnce([[{ pendingCount: 0 }]])
      .mockResolvedValueOnce([[{ id: 7, email: 'y@o.edu', full_name: 'Y', role: 'reviewer', active: 1 }]]);

    await POST(makeReq('POST', { email: 'y@o.edu', full_name: 'Y' }));

    const insertCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO users')
    );
    // role is 3rd param: [email, full_name, role, ...]
    expect(insertCall[1][2]).toBe('reviewer');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/users/:id', () => {
  it('updates full_name and returns updated user', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])  // UPDATE users
      .mockResolvedValueOnce([[{ id: 2, email: 'rev@oberlin.edu', full_name: 'Jane Updated', role: 'reviewer', active: 1 }]]);

    const res  = await PATCH(
      makeReq('PATCH', { full_name: 'Jane Updated' }, '/api/users/2'),
      ctx('2')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.full_name).toBe('Jane Updated');
  });

  it('updates role', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 2, email: 'rev@oberlin.edu', full_name: 'Rev', role: 'admin', active: 1 }]]);

    await PATCH(makeReq('PATCH', { role: 'admin' }, '/api/users/2'), ctx('2'));

    const updateCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE users')
    );
    expect(updateCall[0]).toContain('role = ?');
  });

  it('deactivates user when active=false', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 2, email: 'r@o.edu', full_name: 'R', role: 'reviewer', active: 0 }]]);

    await PATCH(makeReq('PATCH', { active: false }, '/api/users/2'), ctx('2'));

    const updateCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('active = ?')
    );
    expect(updateCall[1]).toContain(0);
  });

  it('replaces source_ids — deletes old then inserts new', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])  // DELETE reviewer_sources
      .mockResolvedValueOnce([[]])  // INSERT reviewer_sources
      .mockResolvedValueOnce([[{ id: 2, email: 'r@o.edu', full_name: 'R', role: 'reviewer', active: 1 }]]);

    await PATCH(makeReq('PATCH', { source_ids: [3, 4] }, '/api/users/2'), ctx('2'));

    const deleteCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM reviewer_sources')
    );
    const insertCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO reviewer_sources')
    );
    expect(deleteCall).toBeDefined();
    expect(insertCall).toBeDefined();
  });

  it('clears all source assignments when source_ids is empty array', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])  // DELETE reviewer_sources (no INSERT follows)
      .mockResolvedValueOnce([[{ id: 2, email: 'r@o.edu', full_name: 'R', role: 'reviewer', active: 1 }]]);

    await PATCH(makeReq('PATCH', { source_ids: [] }, '/api/users/2'), ctx('2'));

    const deleteCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM reviewer_sources')
    );
    expect(deleteCall).toBeDefined();
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await PATCH(makeReq('PATCH', { full_name: 'X' }, '/api/users/2'), ctx('2'))).status).toBe(403);
  });
});
