jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

jest.mock('@/lib/email', () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
}));

import { after, NextRequest } from 'next/server';
import { POST } from '@/app/api/users/invite/route';
import { DELETE, PATCH } from '@/app/api/users/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';
import { sendWelcomeEmail } from '@/lib/email';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockAfter = after as jest.Mock;
const mockSendWelcomeEmail = sendWelcomeEmail as jest.Mock;
const afterCallbacks: Array<() => Promise<void> | void> = [];

const ADMIN = {
  id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin',
  active: 1, firebase_uid: 'uid-admin', can_review_all_sources: 0,
};
const REVIEWER = {
  id: 2, email: 'reviewer@oberlin.edu', role: 'reviewer', full_name: 'Reviewer',
  active: 1, firebase_uid: 'uid-reviewer', can_review_all_sources: 0,
};

function request(method: string, body?: unknown, path = '/api/users') {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function mockAdminAuth() {
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: ADMIN.email });
  db.default.query.mockImplementation((sql: string) => {
    if (sql.includes('WHERE firebase_uid=')) return Promise.resolve([[ADMIN]]);
    if (sql.includes('pendingCount')) return Promise.resolve([[{ pendingCount: 3 }]]);
    return Promise.resolve([[]]);
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockVerify.mockReset();
  mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  });
  afterCallbacks.length = 0;
  mockSendWelcomeEmail.mockReset().mockResolvedValue(undefined);
  mockAdminAuth();
});

describe('POST /api/users/invite', () => {
  it('creates a globally scoped reviewer with an unclaimed NULL uid', async () => {
    const created = {
      id: 5, email: 'jane@oberlin.edu', full_name: 'Jane Smith', role: 'reviewer',
      can_review_all_sources: 1, active: 1,
    };
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('WHERE email=?')) return Promise.resolve([[]]);
      if (sql.includes('INSERT INTO users')) return Promise.resolve([{ insertId: 5 }]);
      if (sql.includes('FROM users WHERE id=?')) return Promise.resolve([[created]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request('POST', {
      email: '  JANE@Oberlin.EDU ',
      full_name: ' Jane   Smith ',
      role: 'reviewer',
      can_review_all_sources: true,
      source_ids: [],
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    const insert = db.mockConn.query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO users'));
    expect(insert[0]).toContain('firebase_uid');
    expect(insert[0]).toContain('NULL');
    expect(insert[1]).toEqual(['jane@oberlin.edu', 'Jane Smith', 'reviewer', 1]);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);

    await afterCallbacks[0]();
    expect(mockSendWelcomeEmail).toHaveBeenCalledWith({
      email: 'jane@oberlin.edu', name: 'Jane Smith', role: 'reviewer', pendingCount: 3,
    });
  });

  it('validates and atomically writes specific source assignments', async () => {
    db.mockConn.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('WHERE email=?')) return Promise.resolve([[]]);
      if (sql.includes('SELECT id FROM sources')) {
        return Promise.resolve([params.map(id => ({ id }))]);
      }
      if (sql.includes('INSERT INTO users')) return Promise.resolve([{ insertId: 6 }]);
      if (sql.includes('FROM users WHERE id=?')) {
        return Promise.resolve([[{
          id: 6, email: 'x@o.edu', full_name: 'X', role: 'reviewer',
          can_review_all_sources: 0, active: 1,
        }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request('POST', {
      email: 'x@o.edu', full_name: 'X', source_ids: [2, 1, 2],
    }));

    expect(response.status).toBe(201);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'INSERT INTO reviewer_sources (reviewer_id, source_id) VALUES ?',
      [[[6, 2], [6, 1]]],
    );
  });

  it('rejects an implicit all-source reviewer', async () => {
    const response = await POST(request('POST', {
      email: 'x@o.edu', full_name: 'X', role: 'reviewer', source_ids: [],
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('explicit all-source access');
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('rejects invalid roles and source ids', async () => {
    expect((await POST(request('POST', {
      email: 'x@o.edu', full_name: 'X', role: 'owner', source_ids: [1],
    }))).status).toBe(400);
    expect((await POST(request('POST', {
      email: 'x@o.edu', full_name: 'X', source_ids: [0],
    }))).status).toBe(400);
  });

  it('rolls back the user when assignment insertion fails', async () => {
    db.mockConn.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('WHERE email=?')) return Promise.resolve([[]]);
      if (sql.includes('SELECT id FROM sources')) return Promise.resolve([params.map(id => ({ id }))]);
      if (sql.includes('INSERT INTO users')) return Promise.resolve([{ insertId: 7 }]);
      if (sql.includes('INSERT INTO reviewer_sources')) return Promise.reject(new Error('foreign key failure'));
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    const response = await POST(request('POST', {
      email: 'x@o.edu', full_name: 'X', source_ids: [1],
    }));
    expect(response.status).toBe(500);
    expect(db.mockConn.rollback).toHaveBeenCalled();
    expect(db.mockConn.commit).not.toHaveBeenCalled();
  });

  it('returns 409 for an existing email', async () => {
    db.mockConn.query.mockResolvedValueOnce([[{ id: 99 }]]);
    const response = await POST(request('POST', {
      email: 'admin@oberlin.edu', full_name: 'Duplicate', role: 'admin',
    }));
    expect(response.status).toBe(409);
  });
});

describe('PATCH /api/users/:id', () => {
  it('replaces reviewer assignments in one transaction', async () => {
    db.mockConn.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM users WHERE id=?') && sql.includes('FOR UPDATE')) return Promise.resolve([[REVIEWER]]);
      if (sql.includes('SELECT id FROM sources')) return Promise.resolve([params.map(id => ({ id }))]);
      if (sql.includes('FROM users WHERE id=?')) return Promise.resolve([[REVIEWER]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    const response = await PATCH(
      request('PATCH', { source_ids: [3, 4] }, '/api/users/2'),
      context('2'),
    );
    expect(response.status).toBe(200);
    expect(db.mockConn.query).toHaveBeenCalledWith('DELETE FROM reviewer_sources WHERE reviewer_id=?', [2]);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'INSERT INTO reviewer_sources (reviewer_id, source_id) VALUES ?',
      [[[2, 3], [2, 4]]],
    );
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
  });

  it('can switch an assigned reviewer to explicit all-source access atomically', async () => {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM users WHERE id=?') && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[REVIEWER]]);
      }
      if (sql.includes('FROM users WHERE id=?')) {
        return Promise.resolve([[
          { ...REVIEWER, can_review_all_sources: 1 },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await PATCH(
      request('PATCH', { can_review_all_sources: true }, '/api/users/2'),
      context('2'),
    );

    expect(response.status).toBe(200);
    expect(db.mockConn.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SELECT source_id FROM reviewer_sources'),
      expect.anything(),
    );
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'DELETE FROM reviewer_sources WHERE reviewer_id=?',
      [2],
    );
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
  });

  it('prevents an administrator from deactivating themself', async () => {
    db.mockConn.query.mockResolvedValueOnce([[ADMIN]]);
    const response = await PATCH(
      request('PATCH', { active: false }, '/api/users/1'),
      context('1'),
    );
    expect(response.status).toBe(400);
    expect(db.mockConn.rollback).toHaveBeenCalled();
  });

  it('preserves the last active administrator', async () => {
    const otherAdmin = { ...ADMIN, id: 3, email: 'other@oberlin.edu', firebase_uid: 'uid-other' };
    db.mockConn.query
      .mockResolvedValueOnce([[otherAdmin]])
      .mockResolvedValueOnce([[{ id: 3 }]]);
    const response = await PATCH(
      request('PATCH', { active: false }, '/api/users/3'),
      context('3'),
    );
    expect(response.status).toBe(409);
  });

  it('rejects malformed patch fields', async () => {
    expect((await PATCH(
      request('PATCH', { role: 'owner' }, '/api/users/2'), context('2'),
    )).status).toBe(400);
    expect((await PATCH(
      request('PATCH', { source_ids: ['abc'] }, '/api/users/2'), context('2'),
    )).status).toBe(400);
  });
});

describe('authorization and delete invariants', () => {
  it('returns 403 for a reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: REVIEWER.firebase_uid, email: REVIEWER.email });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    const response = await PATCH(
      request('PATCH', { full_name: 'No' }, '/api/users/2'), context('2'),
    );
    expect(response.status).toBe(403);
  });

  it('prevents self deletion before opening a transaction', async () => {
    const response = await DELETE(request('DELETE', undefined, '/api/users/1'), context('1'));
    expect(response.status).toBe(400);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });
});
