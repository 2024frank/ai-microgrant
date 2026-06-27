/**
 * Integration: Full Agent Pipeline
 * ──────────────────────────────────────────────────────────────────────────
 * Tests the complete path:
 *   Source registered → Agent runs → Events written to raw_events
 *   → Events appear in reviewer queue → Reviewer approves
 *   → Event submitted to CommunityHub with correct payload
 *
 * The Anthropic SDK and all DB I/O are mocked.
 * What we're testing is that the CONTRACT between each stage is correct —
 * i.e. what the agent writes is exactly what the reviewer queue reads,
 * and what the reviewer approves is exactly what CommunityHub receives.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Module mocks — must be before any imports
// ---------------------------------------------------------------------------
const mockSessionsCreate     = jest.fn();
const mockSessionsEventsSend = jest.fn();
const mockSessionsEventsList = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    beta: {
      sessions: {
        create: mockSessionsCreate,
        events: {
          send: mockSessionsEventsSend,
          list: mockSessionsEventsList,
        },
      },
    },
  })),
}));

jest.mock('@/lib/rejectionHistory', () => ({
  getRejectionHistory: jest.fn().mockResolvedValue({ count: 0, prompt_block: '' }),
}));

const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'ch_post_default_001' })),
});
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { NextRequest } from 'next/server';
import { triggerAgentRun } from '@/lib/agentRunner';
import { GET as getQueue }   from '@/app/api/review/queue/route';
import { GET as getEvent }   from '@/app/api/review/events/[id]/route';
import { POST as postAction } from '@/app/api/review/events/[id]/action/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

// ---------------------------------------------------------------------------
// Realistic test fixtures — modelled on actual Oberlin community events
// ---------------------------------------------------------------------------
const SOURCE = {
  id: 1,
  name: 'Apollo Theatre',
  agent_id: 'agt_apollo_001',
  active: 1,
  calendar_source_name: 'Apollo Theatre Oberlin',
};

// Exactly what a well-behaved agent outputs (camelCase, as documented)
const AGENT_OUTPUT_EVENTS = [
  {
    eventType:            'ot',
    title:                'Jazz Ensemble Concert',
    description:          'The Oberlin Jazz Ensemble performs original compositions and jazz standards.',
    extendedDescription:  'Free admission. Seating is first come, first served. Doors open 30 min before.',
    sponsors:             ['Apollo Theatre', 'Oberlin College'],
    postTypeId:           [8],
    sessions:             [{ startTime: 1748476800, endTime: 1748484000 }], // 2026-05-29 19:00–21:00 UTC
    locationType:         'ph2',
    location:             '19 E College St, Oberlin, OH 44074',
    placeName:            'Apollo Theatre',
    calendarSourceName:   'Apollo Theatre Oberlin',
    calendarSourceUrl:    'https://apollotheatre.org/events/jazz-ensemble',
    geo_scope:            'city_wide',
    contactEmail:         'info@apollotheatre.org',
    website:              'https://apollotheatre.org',
    buttons:              [{ title: 'Event Page', link: 'https://apollotheatre.org/events/jazz-ensemble' }],
  },
  {
    eventType:            'ot',
    title:                'Documentary Film Night',
    description:          'Screening of an award-winning environmental documentary followed by discussion.',
    sponsors:             ['Apollo Theatre'],
    postTypeId:           [5],
    sessions:             [{ startTime: 1748563200, endTime: 1748570400 }],
    locationType:         'ph2',
    location:             '19 E College St, Oberlin, OH 44074',
    placeName:            'Apollo Theatre',
    calendarSourceName:   'Apollo Theatre Oberlin',
    calendarSourceUrl:    'https://apollotheatre.org/events/doc-night',
    geo_scope:            'city_wide',
  },
];

// What raw_events rows look like after agentRunner writes them
// (snake_case, JSON-stringified arrays, as stored in MySQL)
function makeRawEvent(overrides: Record<string, any> = {}) {
  return {
    id:                   10,
    source_id:            1,
    agent_run_id:         99,
    event_type:           'ot',
    title:                'Jazz Ensemble Concert',
    description:          'The Oberlin Jazz Ensemble performs original compositions and jazz standards.',
    extended_description: 'Free admission. Seating is first come, first served. Doors open 30 min before.',
    sponsors:             JSON.stringify(['Apollo Theatre', 'Oberlin College']),
    post_type_ids:        JSON.stringify([8]),
    sessions:             JSON.stringify([{ startTime: 1748476800, endTime: 1748484000 }]),
    location_type:        'ph2',
    location:             '19 E College St, Oberlin, OH 44074',
    place_name:           'Apollo Theatre',
    room_num:             null,
    url_link:             null,
    display:              'all',
    screen_ids:           JSON.stringify([]),
    buttons:              JSON.stringify([{ title: 'Event Page', link: 'https://apollotheatre.org/events/jazz-ensemble' }]),
    contact_email:        'info@apollotheatre.org',
    phone:                null,
    website:              'https://apollotheatre.org',
    image_cdn_url:        null,
    calendar_source_name: 'Apollo Theatre Oberlin',
    calendar_source_url:  'https://apollotheatre.org/events/jazz-ensemble',
    ingested_post_url:    'http://localhost:3000/events/10',
    geo_scope:            'city_wide',
    status:               'pending',
    communityhub_post_id: null,
    created_at:           new Date('2026-05-18T06:00:00Z'),
    updated_at:           new Date('2026-05-18T06:00:00Z'),
    ...overrides,
  };
}

const REVIEWER_USER = {
  id: 5, email: 'reviewer@oberlin.edu', role: 'reviewer',
  full_name: 'Jane Reviewer', active: 1, firebase_uid: 'uid-reviewer',
};

function makeAuthReq(path: string, method = 'GET', body?: any) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockResolvedValue({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
  mockFetch.mockResolvedValue({
    ok: true,
    text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'ch_post_default_001' })),
  });
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
});

// ===========================================================================
// Scenario 1: Agent Run → Correct DB writes
// ===========================================================================
describe('Scenario 1 – Agent run writes events with schema-correct structure', () => {
  beforeEach(() => {
    db.default.query.mockReset();
    db.mockConn.query.mockReset();

    db.default.query
      .mockResolvedValueOnce([[SOURCE]])          // SELECT sources
      .mockResolvedValueOnce([[{ status: 'running' }]]) // stop-status poll
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE agent_runs completed

    // conn queries: 2 per event (INSERT raw_events + UPDATE ingested_post_url)
    db.mockConn.query
      .mockResolvedValueOnce([{ insertId: 10 }]).mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 11 }]).mockResolvedValueOnce([{ affectedRows: 1 }]);

    mockSessionsCreate.mockResolvedValue({ id: 'sess_xyz' });
    mockSessionsEventsSend.mockResolvedValue({});
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: '2026-01-01T00:00:01Z',
          content: [{ type: 'text', text: JSON.stringify(AGENT_OUTPUT_EVENTS) }] },
        { type: 'session.status_idle', created_at: '2026-01-01T00:00:02Z',
          stop_reason: { type: 'end_turn' } },
      ],
    });
  });

  it('calls the agent with the registered source agent_id', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(mockSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      agent: SOURCE.agent_id,
    }));
  });

  it('writes one raw_events row per extracted event', async () => {
    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.inserted).toBe(2);
    expect(result.events).toHaveLength(2);
  });

  it('inserts title, description, and sponsors from agent output', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const insertCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO raw_events')
    );
    expect(insertCall).toBeDefined();
    // title is param index 3 (0=sourceId, 1=runId, 2=eventType, 3=title, ...)
    expect(insertCall[1][3]).toBe('Jazz Ensemble Concert');
    expect(insertCall[1][4]).toContain('Oberlin Jazz Ensemble');
  });

  it('JSON-stringifies array fields (sponsors, sessions, post_type_ids)', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const insertCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO raw_events')
    );
    const sponsorsParam = insertCall[1].find(
      (p: any) => typeof p === 'string' && p.includes('Apollo Theatre') && p.startsWith('[')
    );
    expect(sponsorsParam).toBeDefined();
    expect(() => JSON.parse(sponsorsParam)).not.toThrow();
    expect(JSON.parse(sponsorsParam)).toContain('Apollo Theatre');
  });

  it('sets status to "pending" for all new events', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const insertCalls = db.mockConn.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO raw_events')
    );
    // Both events should end in 'pending' in the INSERT
    insertCalls.forEach((call: any[]) => {
      expect(call[0]).toContain("'pending'");
    });
  });

  it('writes ingestedPostUrl = APP_URL/events/{insertId}', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const urlUpdateCalls = db.mockConn.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('ingested_post_url')
    );
    expect(urlUpdateCalls).toHaveLength(2);
    expect(urlUpdateCalls[0][1][0]).toBe('http://localhost:3000/events/10');
    expect(urlUpdateCalls[1][1][0]).toBe('http://localhost:3000/events/11');
  });

  it('updates agent_run with events_found=2 and events_extracted=2', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const finalUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('events_found')
    );
    expect(finalUpdate[1]).toEqual([2, 2, 99]);
  });

  it('returns event list containing id and ingestedPostUrl for each event', async () => {
    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.events[0]).toMatchObject({
      id:                10,
      title:             'Jazz Ensemble Concert',
      ingested_post_url: 'http://localhost:3000/events/10',
    });
    expect(result.events[1]).toMatchObject({
      id:                11,
      ingested_post_url: 'http://localhost:3000/events/11',
    });
  });
});

// ===========================================================================
// Scenario 2: Reviewer Queue reads events in the right shape
// ===========================================================================
describe('Scenario 2 – Reviewer queue serves events with correct structure', () => {
  const RAW_EVENT = makeRawEvent();

  beforeEach(() => {
    db.default.query.mockReset();
    db.mockConn.query.mockReset();
    db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  });

  it('pending events from agent run appear in reviewer queue', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])           // auth
      .mockResolvedValueOnce([[RAW_EVENT]])               // events query
      .mockResolvedValueOnce([[{ total: 1 }]])            // count query
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo Theatre' }]]); // sources dropdown

    const res  = await getQueue(makeAuthReq('/api/review/queue'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.events).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it('queue event has title, sessions, geo_scope and source_name for the list card', async () => {
    const queueEvent = {
      id:          RAW_EVENT.id,
      title:       RAW_EVENT.title,
      event_type:  RAW_EVENT.event_type,
      description: RAW_EVENT.description,
      sessions:    RAW_EVENT.sessions,
      location_type: RAW_EVENT.location_type,
      geo_scope:   RAW_EVENT.geo_scope,
      created_at:  RAW_EVENT.created_at,
      source_name: SOURCE.name,
      source_slug: 'apollo-theatre',
    };

    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])           // auth
      .mockResolvedValueOnce([[queueEvent]])              // events query
      .mockResolvedValueOnce([[{ total: 1 }]])            // count query
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo Theatre' }]]); // sources dropdown

    const data = await (await getQueue(makeAuthReq('/api/review/queue'))).json();

    expect(data.events[0].title).toBe('Jazz Ensemble Concert');
    expect(data.events[0].source_name).toBe('Apollo Theatre');
    expect(data.events[0].geo_scope).toBe('city_wide');
    // sessions is a JSON string in DB — queue passes it through for client to parse
    expect(data.events[0].sessions).toBeDefined();
  });

  it('full event detail includes all fields needed for the review card', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[{ ...RAW_EVENT, source_name: SOURCE.name, calendar_source_name: SOURCE.calendar_source_name }]])
      .mockResolvedValueOnce([[{ user_count: 1, assignment_count: 0, matching_count: 0 }]]);

    const res  = await getEvent(makeAuthReq('/api/review/events/10'), ctx('10'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.title).toBe('Jazz Ensemble Concert');
    expect(data.extended_description).toContain('Free admission');
    expect(data.contact_email).toBe('info@apollotheatre.org');
    expect(data.ingested_post_url).toBe('http://localhost:3000/events/10');
    expect(data.calendar_source_url).toBe('https://apollotheatre.org/events/jazz-ensemble');
  });

  it('returns 404 for an event that does not exist', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[]]); // not found

    const res = await getEvent(makeAuthReq('/api/review/events/999'), ctx('999'));
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Scenario 3: Approve action → CommunityHub payload integrity
// ===========================================================================
describe('Scenario 3 – Approve sends correct CommunityHub payload', () => {
  const RAW_EVENT = makeRawEvent();

  beforeEach(() => {
    db.default.query.mockReset();
    db.mockConn.query.mockReset();
    db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release          = jest.fn();

    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[RAW_EVENT]])
      .mockResolvedValueOnce([[{ user_count: 1, assignment_count: 0, matching_count: 0 }]])
      .mockResolvedValueOnce([[{ id: 5 }]]); // reviewer db id
  });

  it('submits event to CommunityHub endpoint', async () => {
    await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', { action: 'approve' }),
      ctx('10')
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('communityhub');
    expect(url).toContain('/post/submit');
  });

  it('CommunityHub payload contains all required fields', async () => {
    await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', { action: 'approve' }),
      ctx('10')
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);

    // Required fields per CommunityHub API contract
    expect(body.title).toBe('Jazz Ensemble Concert');
    expect(body.description).toContain('Oberlin Jazz Ensemble');
    expect(body.eventType).toBe('ot');
    expect(body.locationType).toBe('ph2');
    expect(body.location).toBe('19 E College St, Oberlin, OH 44074');
    expect(Array.isArray(body.sponsors)).toBe(true);
    expect(body.sponsors).toContain('Apollo Theatre');
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions[0].startTime).toBe(1748476800);
    expect(Array.isArray(body.postTypeId)).toBe(true);
  });

  it('CommunityHub payload contains ingestedPostUrl for editor deep-link', async () => {
    await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', { action: 'approve' }),
      ctx('10')
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.ingestedPostUrl).toBe('http://localhost:3000/events/10');
    expect(body.calendarSourceName).toBe('Apollo Theatre Oberlin');
  });

  it('reviewer edits are merged into the CommunityHub payload before submission', async () => {
    await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', {
        action: 'approve',
        edits:  { title: 'Jazz Ensemble Spring Concert', description: 'Updated description.' },
      }),
      ctx('10')
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.title).toBe('Jazz Ensemble Spring Concert');
    expect(body.description).toBe('Updated description.');
  });

  it('stores communityhub_post_id returned from CH API on the raw_events row', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ id: 'ch_post_jazz_001' })),
    });

    await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', { action: 'approve' }),
      ctx('10')
    );

    const updateCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='approved'")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain('ch_post_jazz_001');
  });

  it('sets submitted_to_ch=1 and records time_spent in review_sessions', async () => {
    db.mockConn.query.mockClear(); // clear call history; keep mockResolvedValue from beforeEach

    await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', { action: 'approve', time_spent_sec: 42 }),
      ctx('10')
    );

    const sessionInsert = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('review_sessions')
    );
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert[0]).toContain('approved');
    expect(sessionInsert[1]).toContain(42);  // time_spent_sec
    expect(sessionInsert[0]).toContain('submitted_to_ch');
  });

  it('rolls back and returns 500 if CommunityHub is unreachable', async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await postAction(
      makeAuthReq('/api/review/events/10/action', 'POST', { action: 'approve' }),
      ctx('10')
    );
    expect(res.status).toBe(500);
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
    // Event stays pending — not marked approved
    const approveUpdate = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='approved'")
    );
    expect(approveUpdate).toBeUndefined();
  });
});
