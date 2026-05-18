import { NextRequest } from 'next/server';
import { GET } from '@/app/api/review/queue/route';
import { POST } from '@/app/api/review/events/[id]/action/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN = { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const PENDING = {
  id: 10, title: 'Jazz Night', status: 'pending', event_type: 'ot',
  description: 'A great jazz show',
  sessions: JSON.stringify([{ startTime: 1700000000, endTime: 1700003600 }]),
  location_type: 'ph2', location: '39 S Main St', sponsors: JSON.stringify(['Apollo']),
  post_type_ids: JSON.stringify([8]), source_id: 1, source_name: 'Apollo',
  calendar_source_name: 'Apollo', calendar_source_url: 'https://apollotheater.org',
  ingested_post_url: 'http://localhost/events/10', screen_ids: '[]', buttons: '[]', extended_description: null,
};

// Helper — wraps id in a resolved Promise as Next.js 16 requires
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(path: string, body?: any) {
  return new NextRequest(`http://localhost${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
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
});

describe('GET /api/review/queue', () => {
  it('returns pending events', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ total: 1 }]]);

    const data = await (await GET(makeReq('/api/review/queue'))).json();
    expect(data.events[0].title).toBe('Jazz Night');
    expect(data.total).toBe(1);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await GET(new NextRequest('http://localhost/api/review/queue', {}))).status).toBe(401);
  });
});

describe('POST /api/review/events/:id/action', () => {
  it('rejects event successfully', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('/api/review/events/10/action', {
        action: 'reject',
        edits: { reason_codes: ['wrong_audience'] },
        time_spent_sec: 30,
      }),
      ctx('10')
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('returns 400 when reason_codes empty', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'reject', edits: { reason_codes: [] } }),
      ctx('10')
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when event already reviewed', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...PENDING, status: 'approved' }]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'reject', edits: { reason_codes: ['other'] } }),
      ctx('10')
    );
    expect(res.status).toBe(409);
  });

  it('returns 404 when event not found', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('/api/review/events/999/action', { action: 'reject', edits: { reason_codes: ['other'] } }),
      ctx('999')
    );
    expect(res.status).toBe(404);
  });
});
