import { NextRequest } from 'next/server';
import { GET } from '@/app/api/events/[id]/rejection/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const REVIEWER = {
  id: 2,
  email: 'reviewer@oberlin.edu',
  role: 'reviewer',
  full_name: 'Reviewer',
  active: 1,
  firebase_uid: 'uid-reviewer',
};
const ADMIN = {
  ...REVIEWER,
  id: 1,
  email: 'admin@oberlin.edu',
  role: 'admin',
  full_name: 'Admin',
  firebase_uid: 'uid-admin',
};
const REJECTION = {
  reason_codes: '["wrong_date"]',
  reviewer_note: 'The date is from last year.',
  created_at: '2026-07-01T12:00:00Z',
  reviewer_name: 'Admin',
  source_id: 9,
};
const context = { params: Promise.resolve({ id: '44' }) };

function request() {
  return new NextRequest('http://localhost/api/events/44/rejection', {
    headers: { Authorization: 'Bearer valid' },
  });
}

describe('GET /api/events/:id/rejection', () => {
  beforeEach(() => {
    db.default.query.mockReset();
    mockVerify.mockReset();
  });

  it('returns rejection history only when a reviewer can access the event source', async () => {
    mockVerify.mockResolvedValue({ uid: REVIEWER.firebase_uid, email: REVIEWER.email });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[REJECTION]])
      .mockResolvedValueOnce([[{ allowed: 1 }]]);

    const response = await GET(request(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reviewer_note).toBe(REJECTION.reviewer_note);
    expect(body).not.toHaveProperty('source_id');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(db.default.query).toHaveBeenLastCalledWith(
      expect.stringContaining('reviewer_sources'),
      [REVIEWER.firebase_uid, REVIEWER.firebase_uid, REJECTION.source_id],
    );
  });

  it('forbids a reviewer who is not assigned to the event source', async () => {
    mockVerify.mockResolvedValue({ uid: REVIEWER.firebase_uid, email: REVIEWER.email });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[REJECTION]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const response = await GET(request(), context);

    expect(response.status).toBe(403);
  });

  it('keeps administrators global without an assignment lookup', async () => {
    mockVerify.mockResolvedValue({ uid: ADMIN.firebase_uid, email: ADMIN.email });
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[REJECTION]]);

    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(db.default.query).toHaveBeenCalledTimes(2);
  });
});
