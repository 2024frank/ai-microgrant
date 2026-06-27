import { NextRequest } from 'next/server';
import { GET } from '@/app/api/events/route';
import { PATCH } from '@/app/api/events/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockFetch = jest.fn();
global.fetch = mockFetch;

const EVENTS = [
  { id: 1, title: 'Jazz Night',           status: 'pending',  event_type: 'ot', sponsors: '[]', post_type_ids: '[]', sessions: '[]', buttons: '[]' },
  { id: 2, title: 'City Council Meeting', status: 'approved', event_type: 'ot', sponsors: '[]', post_type_ids: '[]', sessions: '[]', buttons: '[]' },
  { id: 3, title: 'Job Opening',          status: 'rejected', event_type: 'jp', sponsors: '[]', post_type_ids: '[]', sessions: '[]', buttons: '[]' },
];

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/events');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
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
    text: jest.fn().mockResolvedValue(JSON.stringify({ ok: true })),
  });
});

describe('GET /api/events (public — no auth required)', () => {
  it('returns all events with pagination', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 3 }]])
      .mockResolvedValueOnce([EVENTS]);

    const res  = await GET(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.events).toHaveLength(3);
    expect(data.pagination.total).toBe(3);
    expect(data.pagination.has_next).toBe(false);
    expect(data.pagination.has_prev).toBe(false);
  });

  it('returns CORS headers', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    const res = await GET(makeReq());
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('filters by status', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[EVENTS[1]]]);

    await GET(makeReq({ status: 'approved' }));
    expect(db.default.query.mock.calls[1][0]).toContain('re.status = ?');
    expect(db.default.query.mock.calls[1][1]).toContain('approved');
  });

  it('filters by source_id', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[EVENTS[0]]]);

    await GET(makeReq({ source_id: '1' }));
    expect(db.default.query.mock.calls[1][0]).toContain('re.source_id = ?');
  });

  it('filters by source_slug', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[EVENTS[0]]]);

    await GET(makeReq({ source_slug: 'oberlin-college' }));
    expect(db.default.query.mock.calls[1][0]).toContain('s.slug = ?');
  });

  it('searches title with LIKE', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[EVENTS[0]]]);

    await GET(makeReq({ q: 'jazz' }));
    expect(db.default.query.mock.calls[1][0]).toContain('LIKE ?');
    expect(db.default.query.mock.calls[1][1]).toContain('%jazz%');
  });

  it('caps limit at 100', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await GET(makeReq({ limit: '9999' }));
    const params = db.default.query.mock.calls[1][1];
    expect(params[params.length - 2]).toBe(100);
  });

  it('calculates pagination correctly', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 55 }]])
      .mockResolvedValueOnce([EVENTS]);

    const data = await (await GET(makeReq({ limit: '10', page: '2' }))).json();
    expect(data.pagination.pages).toBe(6);
    expect(data.pagination.has_prev).toBe(true);
    expect(data.pagination.has_next).toBe(true);
  });

  it('parses JSON fields in response', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[EVENTS[0]]]);

    const data = await (await GET(makeReq())).json();
    expect(Array.isArray(data.events[0].sponsors)).toBe(true);
    expect(Array.isArray(data.events[0].sessions)).toBe(true);
  });
});

describe('PATCH /api/events/:id', () => {
  it('converts data URI image edits to the poster.jpg serving URL for CommunityHub', async () => {
    db.default.query
      .mockResolvedValueOnce([[
        { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' },
      ]])
      .mockResolvedValueOnce([[
        {
          id: 10,
          source_id: 1,
          status: 'approved',
          communityhub_post_id: 'ch_existing_123',
          image_cdn_url: 'http://old.example/image.jpg',
        },
      ]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await PATCH(
      new NextRequest('http://localhost/api/events/10', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: { image_cdn_url: 'data:image/jpeg;base64,abc123' } }),
      }),
      { params: Promise.resolve({ id: '10' }) }
    );

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).image_cdn_url).toBe('http://localhost:3000/api/events/10/poster.jpg');
  });
});
