import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/events/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockFetch  = jest.fn();
global.fetch = mockFetch;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(id: string, body: any) {
  return new NextRequest(`http://localhost/api/events/${id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'ch_existing' })),
  });
});

describe('PATCH /api/events/:id', () => {
  it('sends base64 image edits to CommunityHub as poster.jpg serving URLs', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' }]])
      .mockResolvedValueOnce([[{
        id: 10,
        source_id: 1,
        title: 'Approved event',
        status: 'approved',
        communityhub_post_id: 'ch_existing',
        image_cdn_url: 'http://localhost:3000/api/events/10/poster.jpg',
      }]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await PATCH(
      makeReq('10', { edits: { image_cdn_url: 'data:image/png;base64,abc123' } }),
      ctx('10')
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.image_cdn_url).toBe('http://localhost:3000/api/events/10/poster.jpg');
  });
});
