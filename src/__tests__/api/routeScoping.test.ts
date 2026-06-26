import { NextRequest } from 'next/server';
import { GET as getReviewEvent } from '@/app/api/review/events/[id]/route';
import { POST as sendForCorrection } from '@/app/api/review/events/[id]/send-for-correction/route';
import { PATCH as patchEvent } from '@/app/api/events/[id]/route';
import { GET as getRejection } from '@/app/api/events/[id]/rejection/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockFetch = jest.fn();
global.fetch = mockFetch;

const REVIEWER = {
  id: 2,
  email: 'reviewer@oberlin.edu',
  role: 'reviewer',
  full_name: 'Reviewer',
  active: 1,
  firebase_uid: 'uid-reviewer',
};
const ADMIN = {
  id: 1,
  email: 'admin@oberlin.edu',
  role: 'admin',
  full_name: 'Admin',
  active: 1,
  firebase_uid: 'uid-admin',
};

const EVENT = {
  id: 10,
  source_id: 2,
  title: 'Out-of-scope event',
  status: 'pending',
  communityhub_post_id: 'ch_123',
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(path: string, method = 'GET', body?: any) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function mockOutOfScopeAuth() {
  mockVerify.mockResolvedValueOnce({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
  db.default.query
    .mockResolvedValueOnce([[REVIEWER]])
    .mockResolvedValueOnce([[EVENT]])
    .mockResolvedValueOnce([[{ assigned_count: 1, matching_count: 0 }]]);
}

beforeEach(() => {
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockVerify.mockReset();
  mockFetch.mockReset();
});

describe('event route source scoping', () => {
  it('returns 403 for out-of-scope review event reads', async () => {
    mockOutOfScopeAuth();

    const res = await getReviewEvent(
      makeReq('/api/review/events/10'),
      ctx('10')
    );

    expect(res.status).toBe(403);
  });

  it('returns 403 before sending out-of-scope events for correction', async () => {
    mockOutOfScopeAuth();

    const res = await sendForCorrection(
      makeReq('/api/review/events/10/send-for-correction', 'POST', { correction_notes: 'Fix source details' }),
      ctx('10')
    );

    expect(res.status).toBe(403);
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('returns 409 before starting a fix agent for non-pending events', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...EVENT, status: 'approved' }]]);

    const res = await sendForCorrection(
      makeReq('/api/review/events/10/send-for-correction', 'POST', { correction_notes: 'Fix source details' }),
      ctx('10')
    );

    expect(res.status).toBe(409);
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 before patching out-of-scope live CommunityHub events', async () => {
    mockOutOfScopeAuth();

    const res = await patchEvent(
      makeReq('/api/events/10', 'PATCH', { edits: { title: 'Bad edit' } }),
      ctx('10')
    );

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 for out-of-scope rejection-log reads', async () => {
    mockOutOfScopeAuth();

    const res = await getRejection(
      makeReq('/api/events/10/rejection'),
      ctx('10')
    );

    expect(res.status).toBe(403);
  });
});
