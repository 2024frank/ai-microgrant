import { NextRequest } from 'next/server';
import { GET as getReviewQueue } from '@/app/api/review/queue/route';
import { GET as getReviewEvent } from '@/app/api/review/events/[id]/route';
import { POST as reviewAction } from '@/app/api/review/events/[id]/action/route';
import { POST as sendForCorrection } from '@/app/api/review/events/[id]/send-for-correction/route';
import { adminAuth } from '@/lib/firebase-admin';

// Mock global fetch for CommunityHub API calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN = { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER_A = { id: 2, email: 'rev@oberlin.edu', role: 'reviewer', full_name: 'Rev', active: 1, firebase_uid: 'uid-rev' };
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

function mockActionEvent(event = PENDING, user = ADMIN, reviewer = { id: 1 }) {
  db.default.query
    .mockResolvedValueOnce([[user]])
    .mockResolvedValueOnce([[reviewer]]);
  db.mockConn.query.mockResolvedValueOnce([[event]]);
}

beforeEach(() => {
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
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

    const data = await (await getReviewQueue(makeReq('/api/review/queue'))).json();
    expect(data.events[0].title).toBe('Jazz Night');
    expect(data.total).toBe(1);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await getReviewQueue(new NextRequest('http://localhost/api/review/queue', {}))).status).toBe(401);
  });
});

describe('POST /api/review/events/:id/action', () => {
  it('rejects event successfully', async () => {
    mockActionEvent();

    const res = await reviewAction(
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
      .mockResolvedValueOnce([[ADMIN]]);

    const res = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'reject', edits: { reason_codes: [] } }),
      ctx('10')
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when event already reviewed', async () => {
    mockActionEvent({ ...PENDING, status: 'approved' });

    const res = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'reject', edits: { reason_codes: ['other'] } }),
      ctx('10')
    );
    expect(res.status).toBe(409);
  });

  it('returns 404 when event not found', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ id: 1 }]]);
    db.mockConn.query.mockResolvedValueOnce([[]]);

    const res = await reviewAction(
      makeReq('/api/review/events/999/action', { action: 'reject', edits: { reason_codes: ['other'] } }),
      ctx('999')
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for unknown review action instead of approving', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);

    const res = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'archive' }),
      ctx('10')
    );

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects reviewer actions outside assigned sources before CommunityHub submit', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    mockActionEvent({ ...PENDING, source_id: 2 }, REVIEWER_A, { id: 2 });
    db.mockConn.query.mockResolvedValueOnce([[{ has_assignments: 1, is_assigned: 0 }]]);

    const res = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/review/events/:id/action — approve path', () => {
  it('approves event, calls CommunityHub, stores post_id', async () => {
    mockActionEvent();

    const res  = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'approve', time_spent_sec: 55 }),
      ctx('10')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.communityhub).toEqual({ id: 'ch_post_abc123' });
  });

  it('POSTs correct payload to CommunityHub including ingestedPostUrl', async () => {
    mockActionEvent();

    await reviewAction(
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
    mockActionEvent();

    await reviewAction(
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
    mockActionEvent();

    await reviewAction(
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
    mockActionEvent();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const res = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );
    expect(res.status).toBe(500);
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  });

  it('stores communityhub_post_id returned from CH API', async () => {
    mockActionEvent();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'post_xyz_999' })),
    });

    await reviewAction(
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
    mockActionEvent();

    await reviewAction(
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

  it('locks and rechecks pending status before approving', async () => {
    mockActionEvent({ ...PENDING, status: 'approved' });

    const res = await reviewAction(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.query.mock.calls[0][0]).toContain('FOR UPDATE');
  });
});

describe('Direct review event routes — source scoping', () => {
  it('returns 403 when a reviewer opens an event outside their assigned sources', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])
      .mockResolvedValueOnce([[{ ...PENDING, source_id: 2 }]])
      .mockResolvedValueOnce([[{ has_assignments: 1, is_assigned: 0 }]]);

    const res = await getReviewEvent(makeReq('/api/review/events/10'), ctx('10'));

    expect(res.status).toBe(403);
  });

  it('returns 403 when a reviewer sends an out-of-scope event for correction', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])
      .mockResolvedValueOnce([[{ ...PENDING, source_id: 2 }]])
      .mockResolvedValueOnce([[{ has_assignments: 1, is_assigned: 0 }]]);

    const res = await sendForCorrection(
      makeReq('/api/review/events/10/send-for-correction', { correction_notes: 'Fix source' }),
      ctx('10')
    );

    expect(res.status).toBe(403);
  });
});
