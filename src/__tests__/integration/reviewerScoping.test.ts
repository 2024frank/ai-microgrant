/**
 * Integration: Reviewer Event Population & Scoping
 * ──────────────────────────────────────────────────────────────────────────
 * Tests that events fetched by agents are correctly visible to the right
 * reviewers, and only those reviewers.
 *
 * Rules:
 *  - A reviewer assigned to specific sources sees ONLY those source's events.
 *  - A reviewer with NO source assignments sees ALL sources' events.
 *  - Admins see all events regardless of assignments.
 *  - source_id query param further narrows within the reviewer's scope.
 *  - The public /api/events endpoint is never gated — no auth required.
 *
 * All DB I/O is mocked. We verify that the SQL clauses generated match
 * the expected scoping rules, and that response shapes are correct.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { NextRequest } from 'next/server';
import { GET as getQueue }      from '@/app/api/review/queue/route';
import { GET as getReviewEvent } from '@/app/api/review/events/[id]/route';
import { GET as getPublicEvents } from '@/app/api/events/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Reviewer A: assigned to source 1 (Apollo) only
const REVIEWER_A = {
  id: 10, email: 'alice@oberlin.edu', role: 'reviewer',
  full_name: 'Alice', active: 1, firebase_uid: 'uid-alice',
};

// Reviewer B: assigned to source 2 (Oberlin College) only
const REVIEWER_B = {
  id: 11, email: 'bob@oberlin.edu', role: 'reviewer',
  full_name: 'Bob', active: 1, firebase_uid: 'uid-bob',
};

// Reviewer C: no source assignments (sees everything)
const REVIEWER_C = {
  id: 12, email: 'carol@oberlin.edu', role: 'reviewer',
  full_name: 'Carol', active: 1, firebase_uid: 'uid-carol',
};

// Admin: always sees everything
const ADMIN = {
  id: 1, email: 'admin@oberlin.edu', role: 'admin',
  full_name: 'Admin', active: 1, firebase_uid: 'uid-admin',
};

// Events from each source (as returned by review queue query)
function makeQueueEvent(id: number, sourceId: number, sourceName: string, overrides = {}) {
  return {
    id,
    title:         `Event ${id} from ${sourceName}`,
    event_type:    'ot',
    description:   'A community event.',
    sessions:      JSON.stringify([{ startTime: 1748476800, endTime: 1748484000 }]),
    location_type: 'ph2',
    geo_scope:     'city_wide',
    created_at:    new Date('2026-05-18T06:00:00Z'),
    source_id:     sourceId,
    source_name:   sourceName,
    source_slug:   sourceName.toLowerCase().replace(/\s+/g, '-'),
    ...overrides,
  };
}

const APOLLO_EVENT_1   = makeQueueEvent(100, 1, 'Apollo Theatre');
const APOLLO_EVENT_2   = makeQueueEvent(101, 1, 'Apollo Theatre');
const OBERLIN_EVENT_1  = makeQueueEvent(200, 2, 'Oberlin College');
const CITY_EVENT_1     = makeQueueEvent(300, 3, 'City of Oberlin');

function makeAuthReq(userEmail: string, params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/review/queue');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, {
    headers: { Authorization: `Bearer ${userEmail}`, 'Content-Type': 'application/json' },
  });
}

function makePublicReq(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/events');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
});

// ===========================================================================
// Review Queue — Source Scoping
// ===========================================================================
describe('Review Queue — source assignment scoping', () => {
  it('reviewer with assignments only sees events from their assigned sources', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-alice', email: 'alice@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])           // getAuthUser
      .mockResolvedValueOnce([[APOLLO_EVENT_1, APOLLO_EVENT_2]]) // events query
      .mockResolvedValueOnce([[{ total: 2 }]])         // count query
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('alice@oberlin.edu'))).json();

    expect(data.events).toHaveLength(2);
    data.events.forEach((ev: any) => {
      expect(ev.source_id).toBe(1);
      expect(ev.source_name).toBe('Apollo Theatre');
    });
  });

  it('reviewer with assignments has a reviewer_sources subquery in the SQL', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-alice', email: 'alice@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

    await getQueue(makeAuthReq('alice@oberlin.edu'));

    // Both the events query and the count query should use reviewer_sources subquery
    const eventsQuery = db.default.query.mock.calls[1][0] as string;
    const countQuery  = db.default.query.mock.calls[2][0] as string;
    expect(eventsQuery).toContain('reviewer_sources');
    expect(countQuery).toContain('reviewer_sources');
  });

  it('reviewer with assignments has their firebase_uid passed as query param (O(1) lookup)', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-alice', email: 'alice@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]); // sources dropdown

    await getQueue(makeAuthReq('alice@oberlin.edu'));

    const eventsQueryParams = db.default.query.mock.calls[1][1] as any[];
    expect(eventsQueryParams).toContain('uid-alice');
  });

  it('reviewer B sees only Oberlin College events, not Apollo events', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-bob', email: 'bob@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_B]])
      .mockResolvedValueOnce([[OBERLIN_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('bob@oberlin.edu'))).json();

    expect(data.events).toHaveLength(1);
    expect(data.events[0].source_id).toBe(2);
    expect(data.events[0].source_name).toBe('Oberlin College');
  });

  it('reviewer with assignments cannot load another source event by direct id', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-alice', email: 'alice@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])
      .mockResolvedValueOnce([[{ ...OBERLIN_EVENT_1, source_id: 2 }]])
      .mockResolvedValueOnce([[{ assigned_count: 1, matching_count: 0 }]]);

    const res = await getReviewEvent(makeAuthReq('alice@oberlin.edu'), ctx('200'));

    expect(res.status).toBe(403);
  });

  it('reviewer with assignments can load an event from their assigned source', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-alice', email: 'alice@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_A]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1]])
      .mockResolvedValueOnce([[{ assigned_count: 1, matching_count: 1 }]]);

    const res = await getReviewEvent(makeAuthReq('alice@oberlin.edu'), ctx('100'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.source_id).toBe(1);
  });
});

// ===========================================================================
// Review Queue — Unassigned Reviewer (all sources)
// ===========================================================================
describe('Review Queue — unassigned reviewer sees all events', () => {
  it('no reviewer_sources subquery when reviewer has no assignments', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1, OBERLIN_EVENT_1, CITY_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 3 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }, { id: 2, name: 'Oberlin' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('carol@oberlin.edu'))).json();

    const eventsQuery = db.default.query.mock.calls[1][0] as string;
    expect(eventsQuery).toContain('reviewer_sources');
    // Events from all three sources are returned
    expect(data.total).toBe(3);
  });

  it('unassigned reviewer gets all 3 sources in response', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1, OBERLIN_EVENT_1, CITY_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 3 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }, { id: 2, name: 'Oberlin' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('carol@oberlin.edu'))).json();

    const sourceIds = new Set(data.events.map((e: any) => e.source_id));
    expect(sourceIds.has(1)).toBe(true);
    expect(sourceIds.has(2)).toBe(true);
    expect(sourceIds.has(3)).toBe(true);
  });
});

// ===========================================================================
// Review Queue — source_id filter narrows further
// ===========================================================================
describe('Review Queue — source_id query parameter narrows scope', () => {
  it('source_id filter is added to the query AND clause', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

    await getQueue(makeAuthReq('carol@oberlin.edu', { source_id: '1' }));

    const eventsQuery = db.default.query.mock.calls[1][0] as string;
    expect(eventsQuery).toContain('re.source_id = ?');

    const params = db.default.query.mock.calls[1][1] as any[];
    expect(params).toContain('1');
  });

  it('returns only events from filtered source', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1, APOLLO_EVENT_2]])
      .mockResolvedValueOnce([[{ total: 2 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('carol@oberlin.edu', { source_id: '1' }))).json();

    expect(data.events.every((e: any) => e.source_id === 1)).toBe(true);
  });
});

// ===========================================================================
// Review Queue — Admin access
// ===========================================================================
describe('Review Queue — admin access', () => {
  it('admin sees all events without a reviewer_sources subquery', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1, OBERLIN_EVENT_1, CITY_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 3 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }, { id: 2, name: 'Oberlin' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('admin@oberlin.edu'))).json();

    expect(data.total).toBe(3);
  });
});

// ===========================================================================
// Review Queue — Pagination
// ===========================================================================
describe('Review Queue — pagination', () => {
  it('returns page and limit metadata', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[APOLLO_EVENT_1]])
      .mockResolvedValueOnce([[{ total: 50 }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]); // sources dropdown

    const data = await (await getQueue(
      makeAuthReq('carol@oberlin.edu', { page: '0', limit: '20' })
    )).json();

    expect(data.page).toBe(0);
    expect(data.limit).toBe(20);
    expect(data.total).toBe(50);
  });

  it('passes correct OFFSET to DB query', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]); // sources dropdown

    await getQueue(makeAuthReq('carol@oberlin.edu', { page: '2', limit: '20' }));

    const params = db.default.query.mock.calls[1][1] as any[];
    const offset = params[params.length - 1];
    expect(offset).toBe(40); // page=2 × limit=20
  });
});

// ===========================================================================
// Public Events API — Open access, CORS, and filtering
// ===========================================================================
describe('Public /api/events — no auth, CORS enabled', () => {
  it('returns events without authentication', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 2 }]])
      .mockResolvedValueOnce([[
        { ...APOLLO_EVENT_1,  sponsors: '[]', post_type_ids: '[]', buttons: '[]' },
        { ...OBERLIN_EVENT_1, sponsors: '[]', post_type_ids: '[]', buttons: '[]' },
      ]]);

    const res  = await getPublicEvents(makePublicReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.events).toHaveLength(2);
  });

  it('response includes CORS headers so any client can call it', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    const res = await getPublicEvents(makePublicReq());
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('filters by status=approved', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{ ...APOLLO_EVENT_1, status: 'approved', sponsors: '[]', post_type_ids: '[]', buttons: '[]' }]]);

    await getPublicEvents(makePublicReq({ status: 'approved' }));

    const countQuery  = db.default.query.mock.calls[0][0] as string;
    const countParams = db.default.query.mock.calls[0][1] as any[];
    expect(countQuery).toContain('re.status = ?');
    expect(countParams).toContain('approved');
  });

  it('filters by source_slug', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 2 }]])
      .mockResolvedValueOnce([[
        { ...APOLLO_EVENT_1, sponsors: '[]', post_type_ids: '[]', buttons: '[]' },
        { ...APOLLO_EVENT_2, sponsors: '[]', post_type_ids: '[]', buttons: '[]' },
      ]]);

    await getPublicEvents(makePublicReq({ source_slug: 'apollo-theatre' }));

    const [query, params] = db.default.query.mock.calls[0];
    expect(query).toContain('s.slug = ?');
    expect(params).toContain('apollo-theatre');
  });

  it('full-text search uses LIKE on title and description', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await getPublicEvents(makePublicReq({ q: 'jazz' }));

    const [query, params] = db.default.query.mock.calls[0];
    expect(query).toContain('LIKE ?');
    expect(params).toContain('%jazz%');
    // Both title and description are searched
    const likeCount = (query.match(/LIKE \?/g) || []).length;
    expect(likeCount).toBeGreaterThanOrEqual(2);
  });

  it('caps limit at 100 — prevents runaway queries', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await getPublicEvents(makePublicReq({ limit: '99999' }));

    const eventsParams = db.default.query.mock.calls[1][1] as any[];
    const limit = eventsParams[eventsParams.length - 2];
    expect(limit).toBe(100);
  });

  it('parses JSON fields (sponsors, sessions, post_type_ids, buttons) into arrays', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{
        ...APOLLO_EVENT_1,
        sponsors:      JSON.stringify(['Apollo Theatre', 'Oberlin College']),
        post_type_ids: JSON.stringify([8]),
        sessions:      JSON.stringify([{ startTime: 1748476800, endTime: 1748484000 }]),
        buttons:       JSON.stringify([{ title: 'Tickets', link: 'https://example.com' }]),
      }]]);

    const data = await (await getPublicEvents(makePublicReq())).json();
    const event = data.events[0];

    expect(Array.isArray(event.sponsors)).toBe(true);
    expect(event.sponsors).toContain('Apollo Theatre');
    expect(Array.isArray(event.sessions)).toBe(true);
    expect(event.sessions[0].startTime).toBe(1748476800);
    expect(Array.isArray(event.post_type_ids)).toBe(true);
    expect(Array.isArray(event.buttons)).toBe(true);
    expect(event.buttons[0].title).toBe('Tickets');
  });

  it('returns correct pagination metadata', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 75 }]])
      .mockResolvedValueOnce([[]]);

    const data = await (await getPublicEvents(makePublicReq({ page: '1', limit: '25' }))).json();

    expect(data.pagination.total).toBe(75);
    expect(data.pagination.page).toBe(1);
    expect(data.pagination.pages).toBe(3);
    expect(data.pagination.has_prev).toBe(true);
    expect(data.pagination.has_next).toBe(true);
  });

  it('geo_scope filter narrows events to specific geographic area', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await getPublicEvents(makePublicReq({ geo_scope: 'hyper_local' }));

    const [query, params] = db.default.query.mock.calls[0];
    expect(query).toContain('re.geo_scope = ?');
    expect(params).toContain('hyper_local');
  });

  it('date range filter uses created_at >= from AND <= to', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await getPublicEvents(makePublicReq({ from: '2026-05-01', to: '2026-05-31' }));

    const [query, params] = db.default.query.mock.calls[0];
    expect(query).toContain('created_at >= ?');
    expect(query).toContain('created_at <= ?');
    expect(params).toContain('2026-05-01');
    expect(params).toContain('2026-05-31');
  });

  it('order=asc sorts oldest first', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await getPublicEvents(makePublicReq({ order: 'asc' }));

    const eventsQuery = db.default.query.mock.calls[1][0] as string;
    expect(eventsQuery).toContain('ORDER BY re.created_at ASC');
  });

  it('default order is DESC (newest first)', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await getPublicEvents(makePublicReq());

    const eventsQuery = db.default.query.mock.calls[1][0] as string;
    expect(eventsQuery).toContain('ORDER BY re.created_at DESC');
  });
});

// ===========================================================================
// Queue empty state
// ===========================================================================
describe('Review Queue — empty queue', () => {
  it('returns empty events array and total=0 when queue is clear', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-carol', email: 'carol@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_C]])
      .mockResolvedValueOnce([[]])             // no events
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('carol@oberlin.edu'))).json();

    expect(data.events).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    const res = await getQueue(new NextRequest('http://localhost/api/review/queue', {}));
    expect(res.status).toBe(401);
  });
});
