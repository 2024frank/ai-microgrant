import { NextRequest } from 'next/server';
import { GET } from '@/app/api/review/queue/route';
import { POST } from '@/app/api/review/events/[id]/action/route';
import { adminAuth } from '@/lib/firebase-admin';

// Mock global fetch for CommunityHub API calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN = { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'reviewer@oberlin.edu', role: 'reviewer', full_name: 'Reviewer', active: 1, firebase_uid: 'uid-reviewer' };
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
  db.mockConn.query.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
      return Promise.resolve([[PENDING]]);
    }
    if (typeof sql === 'string' && sql.includes('SELECT id FROM users')) {
      return Promise.resolve([[{ id: 1 }]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  // Reset fetch call history, then set default CommunityHub response
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'ch_post_abc123' })),
  });
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/review/queue', () => {
  it('returns pending events', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

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
      .mockResolvedValueOnce([[ADMIN]]);
    db.mockConn.query.mockImplementationOnce(() => Promise.resolve([[
      { ...PENDING, status: 'approved' },
    ]]));

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'reject', edits: { reason_codes: ['other'] } }),
      ctx('10')
    );
    expect(res.status).toBe(409);
  });

  it('returns 404 when event not found', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]]);
    db.mockConn.query.mockImplementationOnce(() => Promise.resolve([[]]));

    const res = await POST(
      makeReq('/api/review/events/999/action', { action: 'reject', edits: { reason_codes: ['other'] } }),
      ctx('999')
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/review/events/:id/action — approve path', () => {
  it('approves event, calls CommunityHub, stores post_id', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);   // reviewer db id

    const res  = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve', time_spent_sec: 55 }),
      ctx('10')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.communityhub).toEqual({ id: 'ch_post_abc123' });
  });

  it('POSTs correct payload to CommunityHub including ingestedPostUrl', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('communityhub');
    const body = JSON.parse(opts.body);
    expect(body.ingestedPostUrl).toBe(PENDING.ingested_post_url);
    expect(body.calendarSourceName).toBe(PENDING.calendar_source_name);
  });

  it('logs field edits when reviewer sends modified fields', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: { title: 'Corrected Title' },
      }),
      ctx('10')
    );

    const editLogInsert = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('field_edit_log')
    );
    expect(editLogInsert).toBeDefined();
    expect(editLogInsert[1]).toContain('title');
    expect(editLogInsert[1]).toContain('Corrected Title');
  });

  it('does not log field edit when value is unchanged', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: { title: PENDING.title },   // same value — no change
      }),
      ctx('10')
    );

    const editLogInsert = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('field_edit_log')
    );
    expect(editLogInsert).toBeUndefined();
  });

  it('rolls back and returns 500 when CommunityHub call throws', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );
    expect(res.status).toBe(500);
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  });

  it('returns 409 without posting when approving an already approved event', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]]);
    db.mockConn.query.mockImplementationOnce(() => Promise.resolve([[
      { ...PENDING, status: 'approved', communityhub_post_id: 'existing_post' },
    ]]));

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  });

  it('returns 409 without posting when approving an event pending correction', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]]);
    db.mockConn.query.mockImplementationOnce(() => Promise.resolve([[
      { ...PENDING, status: 'pending_fix' },
    ]]));

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  });

  it('returns 403 without posting when reviewer is not assigned to the event source', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]]);
    db.mockConn.query
      .mockImplementationOnce(() => Promise.resolve([[{ ...PENDING, source_id: 99 }]]))
      .mockImplementationOnce(() => Promise.resolve([[{ allowed: 0 }]]));

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  });

  it('stores communityhub_post_id returned from CH API', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'post_xyz_999' })),
    });

    await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    const approveUpdate = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='approved'")
    );
    expect(approveUpdate).toBeDefined();
    expect(approveUpdate[1]).toContain('post_xyz_999');
  });

  it('sets submitted_to_ch=1 in review_sessions on approval', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', { action: 'approve', time_spent_sec: 30 }),
      ctx('10')
    );

    const sessionInsert = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('review_sessions')
    );
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert[0]).toContain("'approved'");
    // submitted_to_ch = 1
    expect(sessionInsert[1]).toContain(1);
  });
});
