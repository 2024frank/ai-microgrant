import { NextRequest } from 'next/server';
import { getAuthUser } from '@/lib/auth';
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
    mockVerify.mockRejectedValueOnce(Object.assign(new Error('Token expired'), {
      code: 'auth/id-token-expired',
    }));
    const result = await getAuthUser(makeReq('bad-token'));
    expect(result).toBeNull();
  });

  it('propagates Firebase configuration failures as service outages', async () => {
    mockVerify.mockRejectedValueOnce(new SyntaxError('Malformed service account JSON'));

    await expect(getAuthUser(makeReq('valid-token'))).rejects.toThrow(
      'Malformed service account JSON',
    );
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
    mockVerify.mockResolvedValueOnce({ uid: 'uid-x', email: 'User@Oberlin.EDU', email_verified: true });
    db.default.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{
        id: 3, email: 'user@oberlin.edu', role: 'reviewer', full_name: 'User X', active: 1, firebase_uid: 'uid-x',
      }]]);

    const result = await getAuthUser(makeReq('valid-token'));
    const queryCall = db.default.query.mock.calls[1];
    expect(queryCall[1]).toEqual(['uid-x', 'user@oberlin.edu']);
    expect(result?.id).toBe(3);
  });

  it('does not bind an invitation from an unverified email claim', async () => {
    mockVerify.mockResolvedValueOnce({
      uid: 'uid-attacker', email: 'admin@oberlin.edu', email_verified: false,
    });
    db.default.query.mockResolvedValueOnce([[]]);

    await expect(getAuthUser(makeReq('valid-token'))).resolves.toBeNull();
    expect(db.default.query).toHaveBeenCalledTimes(1);
  });

  it('never rebinds an account that is already claimed by another uid', async () => {
    mockVerify.mockResolvedValueOnce({
      uid: 'uid-new', email: 'admin@oberlin.edu', email_verified: true,
    });
    db.default.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[]]);

    await expect(getAuthUser(makeReq('valid-token'))).resolves.toBeNull();
    expect(db.default.query.mock.calls[1][0]).toContain('firebase_uid IS NULL');
  });

  it('propagates database outages instead of misreporting them as invalid tokens', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
    db.default.query.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(getAuthUser(makeReq('valid-token'))).rejects.toThrow('database unavailable');
  });
});
