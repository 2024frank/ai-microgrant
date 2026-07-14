import { NextRequest } from 'next/server';
import { GET } from '@/app/api/events/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const context = { params: Promise.resolve({ id: '10' }) };

const EVENT = {
  id: 10,
  source_id: 3,
  title: 'Community Concert',
  status: 'pending',
  sponsors: '[]',
  post_type_ids: '[]',
  sessions: '[]',
  buttons: '[]',
  geo_json: null,
};

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
});

describe('GET /api/events/:id visibility', () => {
  it('hides a pending event from anonymous callers', async () => {
    db.default.query.mockResolvedValueOnce([[EVENT]]);

    const response = await GET(new NextRequest('http://localhost/api/events/10'), context);

    expect(response.status).toBe(404);
  });

  it('serves an approved event publicly with public caching', async () => {
    db.default.query.mockResolvedValueOnce([[
      { ...EVENT, status: 'approved' },
    ]]);

    const response = await GET(new NextRequest('http://localhost/api/events/10'), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
  });

  it('enforces reviewer source assignments for a pending event', async () => {
    const reviewer = {
      id: 2,
      role: 'reviewer',
      active: 1,
      email: 'reviewer@oberlin.edu',
      firebase_uid: 'uid-reviewer',
    };
    mockVerify.mockResolvedValue({ uid: reviewer.firebase_uid, email: reviewer.email });
    db.default.query
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[reviewer]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const response = await GET(new NextRequest('http://localhost/api/events/10', {
      headers: { Authorization: 'Bearer valid' },
    }), context);

    expect(response.status).toBe(403);
  });
});
