import { NextRequest } from 'next/server';
import { GET } from '@/app/api/events/[id]/rejection/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const REVIEWER = {
  id: 2,
  email: 'rev@oberlin.edu',
  role: 'reviewer',
  full_name: 'Reviewer',
  active: 1,
  firebase_uid: 'uid-rev',
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(id: string) {
  return new NextRequest(`http://localhost/api/events/${id}/rejection`, {
    headers: { Authorization: 'Bearer valid' },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
});

describe('GET /api/events/:id/rejection', () => {
  it('forbids assigned reviewers from reading out-of-scope rejection notes', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[
        {
          reason_codes: '["missing_fields"]',
          reviewer_note: 'Needs more detail',
          created_at: '2026-06-01T12:00:00Z',
          reviewer_name: 'Admin',
          source_id: 2,
        },
      ]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const res = await GET(makeReq('20'), ctx('20'));
    expect(res.status).toBe(403);
  });
});
