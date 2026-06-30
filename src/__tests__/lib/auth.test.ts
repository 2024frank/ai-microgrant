import { NextRequest } from 'next/server';
import { canReviewSource, getAuthUser } from '@/lib/auth';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

function makeReq(token?: string) {
  return new NextRequest('http://localhost/api/test', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => jest.clearAllMocks());

describe('getAuthUser', () => {
  it('returns null when no authorization header', async () => {
    const result = await getAuthUser(makeReq());
    expect(result).toBeNull();
  });

  it('returns null when token is invalid', async () => {
    mockVerify.mockRejectedValueOnce(new Error('Token expired'));
    const result = await getAuthUser(makeReq('bad-token'));
    expect(result).toBeNull();
  });

  it('returns null when email not in users table', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-stranger', email: 'stranger@example.com' });
    db.default.query.mockResolvedValueOnce([[]]); // no user found
    const result = await getAuthUser(makeReq('valid-token'));
    expect(result).toBeNull();
  });

  it('returns null when user is inactive', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-disabled', email: 'disabled@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[]]); // active=0 filtered out by query
    const result = await getAuthUser(makeReq('valid-token'));
    expect(result).toBeNull();
  });

  it('returns admin user when token and DB match', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[{
      id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Frank Kusi', active: 1, firebase_uid: 'uid-admin',
    }]]);

    const result = await getAuthUser(makeReq('valid-token'));
    expect(result).not.toBeNull();
    expect(result!.role).toBe('admin');
    expect(result!.email).toBe('admin@oberlin.edu');
  });

  it('returns reviewer user correctly', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-rev', email: 'reviewer@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[{
      id: 2, email: 'reviewer@oberlin.edu', role: 'reviewer', full_name: 'Jane Rev', active: 1, firebase_uid: 'uid-rev',
    }]]);

    const result = await getAuthUser(makeReq('valid-token'));
    expect(result!.role).toBe('reviewer');
  });

  it('queries DB with correct email (lowercased)', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-x', email: 'User@Oberlin.EDU' });
    db.default.query.mockResolvedValueOnce([[{
      id: 3, email: 'user@oberlin.edu', role: 'reviewer', full_name: 'User X', active: 1, firebase_uid: 'uid-x',
    }]]);

    await getAuthUser(makeReq('valid-token'));
    const queryCall = db.default.query.mock.calls[0];
    expect(queryCall[1][0]).toBe('user@oberlin.edu');
  });
});

describe('canReviewSource', () => {
  const admin = { uid: 'uid-admin', email: 'admin@oberlin.edu', role: 'admin' as const, name: 'Admin' };
  const reviewer = { uid: 'uid-rev', email: 'reviewer@oberlin.edu', role: 'reviewer' as const, name: 'Reviewer' };

  it('allows admins without querying reviewer assignments', async () => {
    await expect(canReviewSource(admin, 1)).resolves.toBe(true);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('allows reviewers with no source assignments', async () => {
    db.default.query.mockResolvedValueOnce([[{ allowed: 1 }]]);

    await expect(canReviewSource(reviewer, 1)).resolves.toBe(true);
  });

  it('allows reviewers assigned to the event source', async () => {
    db.default.query.mockResolvedValueOnce([[{ allowed: 1 }]]);

    await expect(canReviewSource(reviewer, 2)).resolves.toBe(true);
    expect(db.default.query.mock.calls[0][0]).toContain('reviewer_sources');
    expect(db.default.query.mock.calls[0][1]).toEqual(['uid-rev', 'uid-rev', 2]);
  });

  it('denies reviewers assigned only to other sources', async () => {
    db.default.query.mockResolvedValueOnce([[{ allowed: 0 }]]);

    await expect(canReviewSource(reviewer, 99)).resolves.toBe(false);
  });
});
