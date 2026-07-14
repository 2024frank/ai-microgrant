/**
 * Integration: Rejection Learning Loop
 * ──────────────────────────────────────────────────────────────────────────
 * Tests the complete feedback cycle that makes agents improve over time:
 *
 *   1. Reviewer rejects an event with reason codes + note
 *      → rejection_log row is written with a full event snapshot
 *
 *   2. getRejectionHistory reads rejection_log
 *      → builds a structured prompt block for the agent
 *      → prompt lists events by name with reason codes and notes
 *      → prompt explains what each reason code means
 *
 *   3. On next agent run, triggerAgentRun injects the prompt block
 *      → the agent's user message contains the rejection examples
 *      → examples are source-scoped (source A's history ≠ source B's)
 *
 * All DB and SDK I/O is mocked. What we verify is the DATA CONTRACT
 * at every handoff: what gets written, how it's formatted, and that
 * it reaches the agent in the right place.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Module mocks
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
        events: { send: mockSessionsEventsSend, list: mockSessionsEventsList },
      },
    },
  })),
}));

// Do NOT mock rejectionHistory here — we want to test the real function
// with mocked DB, so the full formatting logic runs.

import { NextRequest } from 'next/server';
import { POST as postAction } from '@/app/api/review/events/[id]/action/route';
import { getRejectionHistory }  from '@/lib/rejectionHistory';
import { triggerAgentRun }      from '@/lib/agentRunner';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SOURCE_ID = 1;

const REVIEWER_USER = {
  id: 5, email: 'rev@oberlin.edu', role: 'reviewer',
  full_name: 'Jane Reviewer', active: 1, firebase_uid: 'uid-rev',
};

// A realistic pending event that gets rejected
const PENDING_EVENT = {
  id: 10, source_id: SOURCE_ID, agent_run_id: 99,
  title:             'Faculty Senate Open Meeting',
  description:       'Monthly Faculty Senate meeting open to all faculty members.',
  extended_description: null,
  event_type:        'ot',
  status:            'pending',
  sponsors:          JSON.stringify(['Oberlin College']),
  post_type_ids:     JSON.stringify([6]),
  sessions:          JSON.stringify([{ startTime: 1748476800, endTime: 1748480400 }]),
  location_type:     'ph2',
  location:          'Peters Hall, Oberlin College',
  place_name:        'Peters Hall',
  room_num:          '102',
  url_link:          null,
  display:           'all',
  screen_ids:        JSON.stringify([]),
  buttons:           JSON.stringify([]),
  contact_email:     null,
  phone:             null,
  website:           null,
  image_cdn_url:     null,
  calendar_source_name: 'Oberlin College',
  calendar_source_url:  'https://oberlin.edu/events',
  ingested_post_url: 'http://localhost:3000/events/10',
  geo_scope:         'hyper_local',
  communityhub_post_id: null,
  created_at:        new Date('2026-05-18T06:00:00Z'),
  updated_at:        new Date('2026-05-18T06:00:00Z'),
};

// Rejection log rows that would be in DB after several review cycles
const REJECTION_LOG_ROWS = [
  {
    event_title:   'Faculty Senate Open Meeting',
    reason_codes:  JSON.stringify(['wrong_audience']),
    reviewer_note: 'This is restricted to faculty members only, not a public event',
    created_at:    new Date('2026-05-18T10:00:00Z'),
  },
  {
    event_title:   'Summer Jazz Concert',
    reason_codes:  JSON.stringify(['bad_date_parse']),
    reviewer_note: 'Agent extracted 7pm but source said 9pm',
    created_at:    new Date('2026-05-17T10:00:00Z'),
  },
  {
    event_title:   'Department Colloquium',
    reason_codes:  JSON.stringify(['wrong_audience', 'not_public_event']),
    reviewer_note: 'Graduate students only, invitation required',
    created_at:    new Date('2026-05-16T10:00:00Z'),
  },
  {
    event_title:   'Spring Showcase',
    reason_codes:  JSON.stringify(['description_hallucinated']),
    reviewer_note: 'Agent added ticket price info not present in source',
    created_at:    new Date('2026-05-15T10:00:00Z'),
  },
];

const SOURCE_FOR_NEXT_RUN = {
  id: SOURCE_ID, name: 'Oberlin College', agent_id: 'agt_oberlin_001',
  active: 1, calendar_source_name: 'Oberlin College Events',
};

function makeAuthReq(path: string, body?: any) {
  return new NextRequest(`http://localhost${path}`, {
    method: body ? 'POST' : 'GET',
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
  mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });

  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
});

// ===========================================================================
// Stage 1: Reject action writes to rejection_log with correct fields
// ===========================================================================
describe('Stage 1 – Reject action writes a rejection_log row', () => {
  it('writes event title, reason_codes, reviewer_note, and event_snapshot', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[PENDING_EVENT]])
      .mockResolvedValueOnce([[{ allowed: 1 }]])
      .mockResolvedValueOnce([[{ id: 5 }]]);

    await postAction(
      makeAuthReq('/api/review/events/10/action', {
        action: 'reject',
        edits: {
          reason_codes:  ['wrong_audience'],
          reviewer_note: 'This is restricted to faculty members only, not a public event',
        },
        time_spent_sec: 15,
      }),
      ctx('10')
    );

    const rejectionInsert = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('rejection_log')
    );
    expect(rejectionInsert).toBeDefined();

    const [, params] = rejectionInsert;
    // context.params delivers id as a string from the URL
    expect(String(params[0])).toBe('10'); // raw_event_id
    expect(params[1]).toBe(SOURCE_ID);    // source_id
    expect(params[2]).toBe(5);            // reviewer_id
    expect(JSON.parse(params[3])).toContain('wrong_audience');  // reason_codes (JSON array)
    expect(params[4]).toContain('faculty members only');        // reviewer_note
    expect(params[5]).toBe('Faculty Senate Open Meeting');      // event_title
    // event_snapshot is the full event row as JSON
    const snapshot = JSON.parse(params[6]);
    expect(snapshot.id).toBe(10);
    expect(snapshot.title).toBe('Faculty Senate Open Meeting');
  });

  it('sets event status to "rejected" after rejection', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[PENDING_EVENT]])
      .mockResolvedValueOnce([[{ allowed: 1 }]])
      .mockResolvedValueOnce([[{ id: 5 }]]);

    await postAction(
      makeAuthReq('/api/review/events/10/action', {
        action: 'reject',
        edits:  { reason_codes: ['not_public_event'] },
      }),
      ctx('10')
    );

    const statusUpdate = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE raw_events') && c[0].includes("'rejected'")
    );
    expect(statusUpdate).toBeDefined();
  });

  it('records time_spent_sec in review_sessions for research benchmarking', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[PENDING_EVENT]])
      .mockResolvedValueOnce([[{ allowed: 1 }]])
      .mockResolvedValueOnce([[{ id: 5 }]]);

    await postAction(
      makeAuthReq('/api/review/events/10/action', {
        action: 'reject',
        edits:  { reason_codes: ['wrong_audience'] },
        time_spent_sec: 22,
      }),
      ctx('10')
    );

    const sessionInsert = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('review_sessions')
    );
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert[1]).toContain(22);   // time_spent_sec
    // submitted_to_ch=0 is hardcoded in the SQL literal for rejections
    expect(sessionInsert[0]).toContain('submitted_to_ch');
    expect(sessionInsert[0]).toContain(',0)');
  });

  it('requires reason_codes — returns 400 when omitted', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[REVIEWER_USER]])
      .mockResolvedValueOnce([[PENDING_EVENT]])
      .mockResolvedValueOnce([[{ id: 5 }]]);

    const res = await postAction(
      makeAuthReq('/api/review/events/10/action', {
        action: 'reject',
        edits:  { reviewer_note: 'Missing reason_codes' },
      }),
      ctx('10')
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Stage 2: getRejectionHistory builds prompt block for agent learning
// ===========================================================================
describe('Stage 2 – getRejectionHistory builds structured prompt from rejection_log', () => {
  it('returns empty prompt when no rejections exist for this source', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([[]]); // no rows

    const result = await getRejectionHistory(SOURCE_ID, 50);
    expect(result.count).toBe(0);
    expect(result.prompt_block).toBe('');
  });

  it('lists each rejected event with its reason codes', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([REJECTION_LOG_ROWS]);

    const { prompt_block } = await getRejectionHistory(SOURCE_ID, 50);

    expect(prompt_block).toContain('Faculty Senate Open Meeting');
    expect(prompt_block).toContain('wrong_audience');
    expect(prompt_block).toContain('Summer Jazz Concert');
    expect(prompt_block).toContain('bad_date_parse');
    expect(prompt_block).toContain('Department Colloquium');
    expect(prompt_block).toContain('Spring Showcase');
    expect(prompt_block).toContain('description_hallucinated');
  });

  it('includes reviewer notes in the prompt block', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([REJECTION_LOG_ROWS]);

    const { prompt_block } = await getRejectionHistory(SOURCE_ID, 50);

    expect(prompt_block).toContain('faculty members only');
    expect(prompt_block).toContain('Agent extracted 7pm but source said 9pm');
    expect(prompt_block).toContain('Agent added ticket price info');
  });

  it('includes the reason codes reference glossary', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([REJECTION_LOG_ROWS]);

    const { prompt_block } = await getRejectionHistory(SOURCE_ID, 50);

    // All reason codes should be defined so the agent knows what they mean
    expect(prompt_block).toContain('wrong_audience');
    expect(prompt_block).toContain('bad_date_parse');
    expect(prompt_block).toContain('duplicate_missed');
    expect(prompt_block).toContain('description_hallucinated');
    expect(prompt_block).toContain('missing_fields');
    expect(prompt_block).toContain('wrong_geo_scope');
    expect(prompt_block).toContain('not_public_event');
    expect(prompt_block).toContain('wrong_post_type');
    expect(prompt_block).toContain('bad_location');
  });

  it('returns correct count even when prompt_block is capped at 20', async () => {
    // 30 rejections in DB — count=30 but prompt shows only 20
    const manyRows = Array.from({ length: 30 }, (_, i) => ({
      event_title:   `Event ${i}`,
      reason_codes:  JSON.stringify(['other']),
      reviewer_note: '',
      created_at:    new Date(),
    }));

    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([manyRows]);

    const { count, prompt_block } = await getRejectionHistory(SOURCE_ID, 50);

    expect(count).toBe(30);                         // full count for stats
    expect(prompt_block).toContain('Event 0');
    expect(prompt_block).toContain('Event 19');
    expect(prompt_block).not.toContain('Event 20'); // capped at 20 examples
  });

  it('queries only for the specific source — no cross-source leakage', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([[]]);

    await getRejectionHistory(42, 50);

    const [query, params] = db.default.query.mock.calls[0];
    expect(query).toContain('source_id = ?');
    expect(params[0]).toBe(42);
  });

  it('orders by created_at DESC so most recent failures appear first', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([[]]);

    await getRejectionHistory(SOURCE_ID, 50);

    const [query] = db.default.query.mock.calls[0];
    expect(query).toMatch(/ORDER BY created_at DESC/i);
  });
});

// ===========================================================================
// Stage 3: Next agent run receives the rejection history in its message
// ===========================================================================
describe('Stage 3 – Next agent run injects rejection history into agent message', () => {
  function installRunningLeaseFallback() {
    db.default.query.mockImplementation((sql: unknown) => (
      typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
        ? Promise.resolve([[{ status: 'running' }]])
        : Promise.resolve([{ affectedRows: 1 }])
    ));
  }

  // Set up sessions API mocks so triggerAgentRun doesn't throw
  beforeEach(() => {
    mockSessionsCreate.mockResolvedValue({ id: 'sess_xyz' });
    mockSessionsEventsSend.mockResolvedValue({});
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: '2026-01-01T00:00:01Z',
          content: [{ type: 'text', text: JSON.stringify([{ eventType: 'ot', title: 'Test Event', description: 'Desc', sponsors: [], postTypeId: [], sessions: [], locationType: 'ne' }]) }] },
        { type: 'session.status_idle', created_at: '2026-01-01T00:00:02Z', stop_reason: { type: 'end_turn' } },
      ],
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  beforeEach(() => {
    // Agent returns a clean empty response — we only care about what it receives
    db.mockConn.query.mockReset();
    db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);

    mockSessionsCreate.mockResolvedValue({
      id: 'run_next', status: 'completed',
      output_messages: [{ role: 'assistant', content: '[]' }],
    });
  });

  it('injects rejection history when source has prior rejections', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[SOURCE_FOR_NEXT_RUN]])    // sources SELECT
      .mockResolvedValueOnce([REJECTION_LOG_ROWS])       // rejection_log query
      .mockResolvedValueOnce([{ affectedRows: 1 }]);     // UPDATE agent_runs
    installRunningLeaseFallback();

    await triggerAgentRun(SOURCE_ID, 100, 'test-key', 'test-env');

    const agentMessage = mockSessionsEventsSend.mock.calls[0][1].events[0].content[0].text as string;
    expect(agentMessage).toContain('Rejection history');
    expect(agentMessage).toContain('Faculty Senate Open Meeting');
    expect(agentMessage).toContain('wrong_audience');
    expect(agentMessage).toContain('Summer Jazz Concert');
    expect(agentMessage).toContain('bad_date_parse');
  });

  it('includes reviewer notes in the injected agent message', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[SOURCE_FOR_NEXT_RUN]])
      .mockResolvedValueOnce([REJECTION_LOG_ROWS])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    installRunningLeaseFallback();

    await triggerAgentRun(SOURCE_ID, 100, 'test-key', 'test-env');

    const agentMessage = mockSessionsEventsSend.mock.calls[0][1].events[0].content[0].text as string;
    expect(agentMessage).toContain('faculty members only');
    expect(agentMessage).toContain('ticket price info');
  });

  it('sends plain extraction request when no rejections exist', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[SOURCE_FOR_NEXT_RUN]])
      .mockResolvedValueOnce([[]])              // empty rejection_log
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    installRunningLeaseFallback();

    await triggerAgentRun(SOURCE_ID, 100, 'test-key', 'test-env');

    const agentMessage = mockSessionsEventsSend.mock.calls[0][1].events[0].content[0].text as string;
    expect(agentMessage).toContain('Run extraction now.');
    expect(agentMessage).toContain('eventType is only "ot"');
    expect(agentMessage).toContain('Never invent facts');
    expect(agentMessage).not.toContain('Feedback policy');
  });

  it('scopes rejection history to the specific source being run', async () => {
    db.default.query.mockReset();
    db.default.query
      .mockResolvedValueOnce([[SOURCE_FOR_NEXT_RUN]])
      .mockResolvedValueOnce([[]])              // empty rejection_log
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    installRunningLeaseFallback();

    await triggerAgentRun(SOURCE_ID, 100, 'test-key', 'test-env');

    // The rejection_log query must have been called with the correct source_id
    const rejectionQuery = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('rejection_log')
    );
    expect(rejectionQuery).toBeDefined();
    expect(rejectionQuery[1][0]).toBe(SOURCE_ID);
  });

  it('two different sources receive their own independent rejection histories', async () => {
    const SOURCE_2 = { ...SOURCE_FOR_NEXT_RUN, id: 2, agent_id: 'agt_apollo_001', name: 'Apollo Theatre' };

    const SOURCE_1_REJECTIONS = [{
      event_title: 'Oberlin Staff Meeting',
      reason_codes: JSON.stringify(['wrong_audience']),
      reviewer_note: 'Staff only',
      created_at: new Date(),
    }];
    const SOURCE_2_REJECTIONS = [{
      event_title: 'Apollo Film Screening',
      reason_codes: JSON.stringify(['bad_date_parse']),
      reviewer_note: 'Wrong time extracted',
      created_at: new Date(),
    }];

    // Run source 1
    db.default.query.mockReset();
    db.mockConn.query.mockReset();
    db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
    db.default.query
      .mockResolvedValueOnce([[SOURCE_FOR_NEXT_RUN]])
      .mockResolvedValueOnce([SOURCE_1_REJECTIONS])     // rejection_log
      .mockResolvedValueOnce([{ affectedRows: 1 }]);    // UPDATE agent_runs
    installRunningLeaseFallback();

    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const msg1 = mockSessionsEventsSend.mock.calls[0][1].events[0].content[0].text as string;

    // Run source 2
    db.default.query
      .mockResolvedValueOnce([[SOURCE_2]])
      .mockResolvedValueOnce([SOURCE_2_REJECTIONS])     // rejection_log
      .mockResolvedValueOnce([{ affectedRows: 1 }]);    // UPDATE agent_runs

    await triggerAgentRun(2, 99, 'test-key', 'test-env');
    const msg2 = mockSessionsEventsSend.mock.calls[1][1].events[0].content[0].text as string;

    // Source 1's agent sees its own history
    expect(msg1).toContain('Oberlin Staff Meeting');
    expect(msg1).not.toContain('Apollo Film Screening');

    // Source 2's agent sees its own history
    expect(msg2).toContain('Apollo Film Screening');
    expect(msg2).not.toContain('Oberlin Staff Meeting');
  });
});

// ===========================================================================
// Stage 4: Full cycle verified end-to-end (reject → history → next run)
// ===========================================================================
describe('Stage 4 – Complete cycle: Reject → History built → Agent learns', () => {
  function installRunningLeaseFallback() {
    db.default.query.mockImplementation((sql: unknown) => (
      typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
        ? Promise.resolve([[{ status: 'running' }]])
        : Promise.resolve([{ affectedRows: 1 }])
    ));
  }

  beforeEach(() => {
    mockSessionsCreate.mockResolvedValue({ id: 'sess_xyz' });
    mockSessionsEventsSend.mockResolvedValue({});
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: '2026-01-01T00:00:01Z',
          content: [{ type: 'text', text: JSON.stringify([{ eventType: 'ot', title: 'Test', description: 'D', sponsors: [], postTypeId: [], sessions: [], locationType: 'ne' }]) }] },
        { type: 'session.status_idle', created_at: '2026-01-01T00:00:02Z', stop_reason: { type: 'end_turn' } },
      ],
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('event rejected by reviewer appears as a learning example in next agent run', async () => {
    // Step A: Simulate the rejection being in the DB (what Stage 1 wrote)
    const rejectionInDb = [{
      event_title:   PENDING_EVENT.title,
      reason_codes:  JSON.stringify(['wrong_audience']),
      reviewer_note: 'This is restricted to faculty members only, not a public event',
      created_at:    new Date(),
    }];

    // Step B: getRejectionHistory reads it and formats the prompt
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([rejectionInDb]);

    const { prompt_block } = await getRejectionHistory(SOURCE_ID, 50);

    // The rejected event title and reason appear in the prompt
    expect(prompt_block).toContain('Faculty Senate Open Meeting');
    expect(prompt_block).toContain('wrong_audience');
    expect(prompt_block).toContain('faculty members only');

    // Step C: triggerAgentRun injects this prompt into the next agent call
    db.mockConn.query.mockReset();
    db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);

    db.default.query
      .mockResolvedValueOnce([[SOURCE_FOR_NEXT_RUN]])
      .mockResolvedValueOnce([rejectionInDb])   // rejection_log query
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    installRunningLeaseFallback();

    mockSessionsCreate.mockResolvedValue({
      id: 'run_after_learning', status: 'completed',
      output_messages: [{ role: 'assistant', content: '[]' }],
    });

    await triggerAgentRun(SOURCE_ID, 100, 'test-key', 'test-env');

    const injectedMessage = mockSessionsEventsSend.mock.calls[0][1].events[0].content[0].text as string;

    // The agent's next prompt contains the feedback from the reviewer
    expect(injectedMessage).toContain('Rejection history');
    expect(injectedMessage).toContain('Faculty Senate Open Meeting');
    expect(injectedMessage).toContain('wrong_audience');
    expect(injectedMessage).toContain('faculty members only');

    // The agent also receives the glossary so it understands the reason codes
    expect(injectedMessage).toContain('restricted to staff/students only');
  });
});
