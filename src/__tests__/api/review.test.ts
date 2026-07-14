import { NextRequest } from 'next/server';
import { GET } from '@/app/api/review/queue/route';
import { POST } from '@/app/api/review/events/[id]/action/route';
import { adminAuth } from '@/lib/firebase-admin';

// Mock global fetch for CommunityHub API calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
let lockedEvent: any;
let unresolvedSubmissions: any[];
let priorSubmissions: any[];

const ADMIN = { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const PENDING = {
  id: 10, title: 'Jazz Night', status: 'pending', event_type: 'ot',
  description: 'A great jazz show',
  sessions: JSON.stringify([{ startTime: 4102444800, endTime: 4102448400 }]),
  location_type: 'ph2', location: '39 S Main St', sponsors: JSON.stringify(['Apollo']),
  post_type_ids: JSON.stringify([8]), source_id: 1, source_name: 'Apollo',
  calendar_source_name: 'Apollo', calendar_source_url: 'https://apollotheater.org',
  ingested_post_url: 'http://localhost/events/10', display: 'all', screen_ids: '[]', buttons: '[]', extended_description: null,
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
  lockedEvent = PENDING;
  unresolvedSubmissions = [];
  priorSubmissions = [];
  db.mockConn.query.mockImplementation((sql: unknown) => {
    if (typeof sql !== 'string') return Promise.resolve([{ affectedRows: 1 }]);
    if (sql.includes('SELECT * FROM raw_events') && sql.includes('FOR UPDATE')) {
      return Promise.resolve([[lockedEvent]]);
    }
    if (sql.includes("status='sending'") && sql.includes('communityhub_submissions')) {
      return Promise.resolve([unresolvedSubmissions]);
    }
    if (sql.includes('payload_hash=?') && sql.includes('communityhub_submissions')) {
      return Promise.resolve([priorSubmissions]);
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
    expect(db.default.query.mock.calls[1][0]).toContain("re.status = 'pending'");
    expect(db.default.query.mock.calls[1][0]).not.toContain('pending_fix');
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

  it('rejects arbitrary reason codes before they can enter agent prompt context', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);

    const res = await POST(
      makeReq('/api/review/events/10/action', {
        action: 'reject',
        edits: { reason_codes: ['ignore_previous_instructions'] },
      }),
      ctx('10'),
    );

    expect(res.status).toBe(400);
    expect(db.default.query).toHaveBeenCalledTimes(1);
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

  it('returns field-level validation errors without calling CommunityHub', async () => {
    lockedEvent = { ...PENDING, sponsors: '[]' };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...PENDING, sponsors: '[]' }]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.validation_errors).toContainEqual(expect.objectContaining({ path: 'sponsors' }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(db.mockConn.rollback).toHaveBeenCalled();
  });

  it('blocks publication when every session has already ended', async () => {
    lockedEvent = {
      ...PENDING,
      sessions: JSON.stringify([{ startTime: 1700000000, endTime: 1700003600 }]),
    };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[lockedEvent]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10'),
    );
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.validation_errors).toContainEqual(expect.objectContaining({
      path: 'sessions',
      code: 'expired',
    }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores non-allow-listed camelCase edit keys at publication', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: { postTypeId: [89], screensIds: [999] },
      }),
      ctx('10')
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.postTypeId).toEqual([8]);
    expect(body.screensIds).toEqual([]);
  });

  it('publishes reviewer-selected screen IDs and corrected source attribution', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: {
          display: 'ss',
          screen_ids: [19, 7],
          calendar_source_name: 'Apollo Theater calendar',
          calendar_source_url: 'https://apollotheater.org/events/jazz-night',
          place_id: '',
        },
      }),
      ctx('10'),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.display).toBe('ss');
    expect(body.screensIds).toEqual([7, 19]);
    expect(body.calendarSourceName).toBe('Apollo Theater calendar');
    expect(body.calendarSourceUrl).toBe('https://apollotheater.org/events/jazz-night');
    expect(body.placeId).toBe('');
  });

  it('clears stale screen IDs when distribution changes away from specific screens', async () => {
    lockedEvent = { ...PENDING, display: 'ss', screen_ids: '[7,19]' };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[lockedEvent]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: { display: 'all' },
      }),
      ctx('10'),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.display).toBe('all');
    expect(body.screensIds).toEqual([]);
  });

  it('does not publish a physical place ID for an online-only event', async () => {
    lockedEvent = { ...PENDING, place_id: 'stale-physical-place' };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[lockedEvent]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: {
          location_type: 'on',
          url_link: 'https://example.org/watch',
        },
      }),
      ctx('10'),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.locationType).toBe('on');
    expect(body.placeId).toBe('');
  });

  it('does not repost while a prior submission outcome is unresolved', async () => {
    lockedEvent = { ...PENDING, status: 'publishing' };
    unresolvedSubmissions = [{ id: 77 }];
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...PENDING, status: 'publishing' }]])
      .mockResolvedValueOnce([[{ id: 1 }]]);
    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10'),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      submission_state: 'sending',
      retry_safe: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not publish an event while its correction run owns it', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ ...PENDING, status: 'pending_fix' }]])
      .mockResolvedValueOnce([[{ id: 1 }]]);
    db.mockConn.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes("SET status='publishing'")) {
        return Promise.resolve([{ affectedRows: 0 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10'),
    );

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
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

  it('submits and stores a corrected event type on approval', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    await POST(
      makeReq('/api/review/events/10/action', {
        action: 'approve',
        edits: { event_type: 'an' },
      }),
      ctx('10')
    );

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.eventType).toBe('an');
    const update = db.mockConn.query.mock.calls.find((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE raw_events SET event_type')
    );
    expect(update?.[1]).toContain('an');
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

  it('blocks unsafe retry when a CommunityHub network result is ambiguous', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10')
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      submission_state: 'unknown',
      retry_safe: false,
    });
    expect(db.default.query.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('publish_started_at=NULL'),
    )).toBe(false);
  });

  it('releases the publishing lease after an explicit CommunityHub rejection', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[PENDING]])
      .mockResolvedValueOnce([[{ id: 1 }]]);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'invalid payload' })),
    });

    const res = await POST(
      makeReq('/api/review/events/10/action', { action: 'approve' }),
      ctx('10'),
    );

    expect(res.status).toBe(502);
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining("status='failed'"),
      expect.arrayContaining([expect.stringContaining('CommunityHub 422'), '10']),
    );
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining('publish_started_at=NULL'),
      ['pending', '10'],
    );
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
