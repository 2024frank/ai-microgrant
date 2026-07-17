import { NextRequest } from 'next/server';
import { GET } from '@/app/api/review/events/[id]/route';
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
const EVENT = { id: 10, source_id: 7, title: 'Assigned event' };

function context() {
  return { params: Promise.resolve({ id: '10' }) };
}

function request() {
  return new NextRequest('http://localhost/api/review/events/10', {
    headers: { Authorization: 'Bearer valid' },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
});

describe('GET /api/review/events/:id assignment scope', () => {
  it('returns the event when the reviewer can access its source', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[
        { ...EVENT, image_data: 'data:image/jpeg;base64,bG9uZw==' },
      ]])
      .mockResolvedValueOnce([[{ allowed: 1 }]]);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ...EVENT,
      has_image_data: true,
      publishing_email_configured: true,
    });
    expect(body).not.toHaveProperty('image_data');
    expect(db.default.query.mock.calls[1][0]).toContain('rejection_log');
    expect(db.default.query.mock.calls[1][0]).not.toContain('re.*');
  });

  it('fails closed when the assignment lookup result is missing', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce(undefined);

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
  });

  it('returns 403 when the source is outside the reviewer assignment', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
  });
});
