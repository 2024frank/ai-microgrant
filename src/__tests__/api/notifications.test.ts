/**
 * POST /api/notifications/review
 *
 * Emails all active reviewers about pending events.
 * Skips reviewers with zero pending. Resend is mocked.
 */

const mockSend = jest.fn().mockResolvedValue({ id: 'msg-id' });

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockSend } })),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/notifications/review/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN    = { id: 1, email: 'admin@oberlin.edu', role: 'admin',    full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'rev@oberlin.edu',   role: 'reviewer', full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };

function makeReq() {
  return new NextRequest('http://localhost/api/notifications/review', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid' },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockSend.mockClear();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
  jest.resetModules();
});

describe('POST /api/notifications/review', () => {
  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    const res = await POST(new NextRequest('http://localhost/api/notifications/review', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await POST(makeReq())).status).toBe(403);
  });

  it('returns notified=0 when no reviewers exist', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]]); // no reviewers

    const data = await (await POST(makeReq())).json();
    expect(data.notified).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it('skips reviewers with no pending events', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...REVIEWER, source_names: 'Apollo' }]])  // reviewer with assignment
      .mockResolvedValueOnce([[]])   // pending sources query → zero count
      .mockResolvedValueOnce([[{ created_at: new Date() }]]); // oldest pending

    const data = await (await POST(makeReq())).json();
    expect(data.notified).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('emails reviewer when they have pending events (assigned sources)', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...REVIEWER, source_names: 'Apollo' }]])
      .mockResolvedValueOnce([[{ name: 'Apollo', count: 5 }]])  // pending sources
      .mockResolvedValueOnce([[{ created_at: new Date('2026-05-01') }]]); // oldest

    const data = await (await POST(makeReq())).json();
    expect(data.notified).toBe(1);
    expect(data.results[0].sent).toBe(true);
    expect(data.results[0].pending).toBe(5);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: REVIEWER.email,
    }));
  });

  it('emails reviewer with all-source view when no specific assignment', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...REVIEWER, source_names: null }]])    // no assignment
      .mockResolvedValueOnce([[{ name: 'Apollo', count: 3 }, { name: 'City', count: 2 }]]) // all sources pending
      .mockResolvedValueOnce([[{ created_at: new Date() }]]);

    const data = await (await POST(makeReq())).json();
    expect(data.notified).toBe(1);
    expect(data.results[0].pending).toBe(5); // 3 + 2
  });

  it('marks result sent=false and records error when email send throws', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...REVIEWER, source_names: 'Apollo' }]])
      .mockResolvedValueOnce([[{ name: 'Apollo', count: 2 }]])
      .mockResolvedValueOnce([[{ created_at: new Date() }]]);

    mockSend.mockRejectedValueOnce(new Error('Resend rate limit'));

    const data = await (await POST(makeReq())).json();
    expect(data.results[0].sent).toBe(false);
    expect(data.results[0].error).toContain('Resend rate limit');
  });

  it('notifies multiple reviewers independently', async () => {
    const reviewer2 = { id: 3, email: 'rev2@oberlin.edu', full_name: 'Rev Two', source_names: 'Oberlin' };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        { ...REVIEWER, source_names: 'Apollo' },
        reviewer2,
      ]])
      .mockResolvedValueOnce([[{ name: 'Apollo', count: 4 }]])  // reviewer 1 pending
      .mockResolvedValueOnce([[{ created_at: new Date() }]])    // reviewer 1 oldest
      .mockResolvedValueOnce([[{ name: 'Oberlin', count: 2 }]]) // reviewer 2 pending
      .mockResolvedValueOnce([[{ created_at: new Date() }]]);   // reviewer 2 oldest

    const data = await (await POST(makeReq())).json();
    expect(data.notified).toBe(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
