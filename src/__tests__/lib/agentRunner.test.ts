/**
 * agentRunner — unit tests
 * Mocks the Anthropic Sessions API used by the current implementation.
 */

// ── Mock Anthropic SDK ──────────────────────────────────────────────────────
const mockSessionsCreate     = jest.fn();
const mockSessionsDelete     = jest.fn();
const mockSessionsEventsSend = jest.fn();
const mockSessionsEventsList = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    beta: {
      sessions: {
        create: mockSessionsCreate,
        delete: mockSessionsDelete,
        events: {
          send: mockSessionsEventsSend,
          list: mockSessionsEventsList,
        },
      },
    },
  })),
}));

jest.mock('@/lib/rejectionHistory', () => ({
  getRejectionHistory: jest.fn(),
}));

import { continueAgentRun, monitorAgentRun, triggerAgentRun } from '@/lib/agentRunner';
import { getRejectionHistory } from '@/lib/rejectionHistory';

const db             = require('@/lib/db');
const mockGetHistory = getRejectionHistory as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SOURCE = {
  id: 1, name: 'Apollo Theatre', agent_id: 'agt_abc', active: 1,
  calendar_source_name: 'Apollo Theatre',
};

const AGENT_EVENT = {
  eventType: 'ot', title: 'Jazz Night', description: 'Live jazz at Apollo.',
  image_cdn_url: 'https://images.example.org/poster.jpg',
  website: 'https://www.example.org/events/jazz-night',
  sponsors: ['Apollo Theatre'], postTypeId: [8],
  sessions: [{ startTime: 2000000000, endTime: 2000003600 }],
  locationType: 'ph2', location: '19 E College St, Oberlin, OH 44074',
  display: 'all',
  geo_scope: 'city_wide',
};

// Build a Sessions API event list response that includes an agent.message
// with JSON output, followed by session.status_idle
function makeSessionEvents(events: object[] = [AGENT_EVENT]) {
  return {
    data: [
      {
        type: 'agent.message',
        processed_at: '2026-01-01T00:00:01Z',
        content: [{ type: 'text', text: JSON.stringify(events) }],
      },
      {
        type: 'session.status_idle',
        processed_at: '2026-01-01T00:00:02Z',
        stop_reason: { type: 'end_turn' },
      },
    ],
  };
}

function makeSessionText(text: string, sequence = 1) {
  return {
    data: [
      {
        type: 'agent.message',
        processed_at: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`,
        content: [{ type: 'text', text }],
      },
      {
        type: 'session.status_idle',
        processed_at: `2026-01-01T00:00:${String(sequence + 1).padStart(2, '0')}Z`,
        stop_reason: { type: 'end_turn' },
      },
    ],
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  delete process.env.AGENT_JSON_REPAIR_ATTEMPTS;
  delete process.env.AGENT_RUN_TIMEOUT_MS;
  delete process.env.AGENT_SESSION_MAX_MINUTES;

  mockGetHistory.mockResolvedValue({ count: 0, prompt_block: '' });

  mockSessionsCreate.mockResolvedValue({ id: 'sess_xyz' });
  mockSessionsDelete.mockResolvedValue({});
  mockSessionsEventsSend.mockResolvedValue({});
  mockSessionsEventsList.mockResolvedValue(makeSessionEvents());

  // Fallback for pool.query once a test's ordered mockResolvedValueOnce values
  // are exhausted: the stop-fix added a session-id UPDATE and a per-poll
  // `SELECT status FROM agent_runs` stop-check. The stop-check must return a
  // non-stopped row (not undefined) or the destructure throws before extraction.
  db.default.query.mockImplementation((sql: unknown) =>
    typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
      ? Promise.resolve([[{ status: 'running' }]])
      : typeof sql === 'string' && /SELECT ar\.status, ar\.events_found/i.test(sql)
      ? Promise.resolve([[
          {
            status: 'running', events_found: 0, events_extracted: 0,
            events_skipped_dup: 0, events_errored: 0, persisted_events: 0,
          },
        ]])
      : typeof sql === 'string' && /FROM sources/i.test(sql)
      ? Promise.resolve([[SOURCE]])
      : Promise.resolve([{ affectedRows: 1 }]),
  );

  db.mockConn.query
    .mockResolvedValueOnce([[]])                 // dedup SELECT — no existing dup
    .mockResolvedValueOnce([{ insertId: 42 }])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
});

function setupPoolHappyPath() {
  db.default.query
    .mockResolvedValueOnce([[SOURCE]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE agent_runs completed
}

// ── Happy path ────────────────────────────────────────────────────────────────
describe('triggerAgentRun — happy path', () => {
  beforeEach(setupPoolHappyPath);

  it('returns run_id, inserted count, and event list', async () => {
    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.run_id).toBe(99);
    expect(result.inserted).toBe(1);
    expect(result.events[0].title).toBe('Jazz Night');
  });

  it('creates a session with agent_id and environment_id', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(mockSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      agent: SOURCE.agent_id,
      environment_id: 'test-env',
    }));
  });

  it('sends a user message to the session', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(mockSessionsEventsSend).toHaveBeenCalledWith(
      'sess_xyz',
      expect.objectContaining({ events: expect.any(Array) })
    );
  });

  it('uses processed_at to drain session events beyond the first 100 items', async () => {
    const buffered = Array.from({ length: 100 }, (_, index) => ({
      id: `event-${index}`,
      type: 'agent.tool_result',
      processed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    }));
    mockSessionsEventsList
      .mockResolvedValueOnce({ data: buffered })
      .mockResolvedValueOnce(makeSessionEvents());

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');

    expect(result).toMatchObject({ status: 'completed', inserted: 1 });
    expect(mockSessionsEventsList.mock.calls[1][1]).toEqual(expect.objectContaining({
      'created_at[gt]': buffered.at(-1)?.processed_at,
      order: 'asc',
    }));
  });

  it('sends the exact constrained payload choices and anti-invention rules', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const message = mockSessionsEventsSend.mock.calls[0][1].events[0].content[0].text;

    expect(message).toContain('eventType is only "ot"');
    expect(message).toContain('8 Music Performance');
    expect(message).toContain('59 Ecolympics or Environmental');
    expect(message).toContain('locationType is ph2/on/bo/ne');
    expect(message).toContain('ps (school screens)');
    expect(message).toContain('never invent a duration');
    expect(message).toContain('future or currently ongoing');
    expect(message).toContain('Re-read the current source each run');
  });

  it('builds ingestedPostUrl using APP_URL and inserted row id', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const updateCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('ingested_post_url')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toContain('/events/42');
  });

  it('updates agent_run completed with events_found and events_extracted', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const updateCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string'
        && c[0].includes("status='completed'")
        && c[0].includes('events_found=?')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual(expect.arrayContaining([1, 1, 99]));
  });

  it('injects rejection history into agent message when available', async () => {
    mockGetHistory.mockResolvedValueOnce({
      count: 3,
      prompt_block: '## Rejection history\n- "Old Event" → REJECTED: wrong_audience',
    });
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const sendCall = mockSessionsEventsSend.mock.calls[0][1];
    const msgText = sendCall.events[0].content[0].text;
    expect(msgText).toContain('Rejection history');
  });

  it('sends plain message when no rejection history', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    const sendCall = mockSessionsEventsSend.mock.calls[0][1];
    const msgText = sendCall.events[0].content[0].text;
    expect(msgText).toContain('Run extraction now');
    expect(msgText).not.toContain('Rejection history');
  });

  it('queries rejection history with correct sourceId and limit=50', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(mockGetHistory).toHaveBeenCalledWith(1, 50);
  });

  it('wraps writeEvents in a transaction', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
    expect(db.mockConn.rollback).not.toHaveBeenCalled();
  });

  it('releases the DB connection after success', async () => {
    await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });
});

// ── Multiple events ───────────────────────────────────────────────────────────
describe('triggerAgentRun — multiple events', () => {
  it('isolates each inserted event in its own transaction', async () => {
    // Three genuinely distinct events: whole-content batch matching preserves
    // near-identical items as duplicates, so each needs its own content.
    const events = [
      { ...AGENT_EVENT, title: 'Morning Yoga Session', description: 'A gentle sunrise yoga class for all levels.', sessions: [{ startTime: 2000000000, endTime: 2000003600 }] },
      { ...AGENT_EVENT, title: 'Jazz Trio Performance', description: 'An evening set from the resident jazz trio.', sessions: [{ startTime: 2000100000, endTime: 2000103600 }] },
      { ...AGENT_EVENT, title: 'Pottery Wheel Workshop', description: 'Hands-on wheel throwing for beginners at the studio.', sessions: [{ startTime: 2000200000, endTime: 2000203600 }] },
    ];
    mockSessionsEventsList.mockResolvedValue(makeSessionEvents(events));

    db.mockConn.query
      .mockReset()
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ insertId: 10 }]).mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ insertId: 11 }]).mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ insertId: 12 }]).mockResolvedValueOnce([{ affectedRows: 1 }]);

    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.inserted).toBe(3);
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(3);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(3);
  });

  it('fails a rejected multi-item correction instead of reporting completion', async () => {
    mockSessionsEventsList.mockResolvedValue(makeSessionEvents([
      { ...AGENT_EVENT, title: 'Correction A' },
      { ...AGENT_EVENT, title: 'Correction B' },
    ]));
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(triggerAgentRun(
      1,
      99,
      'test-key',
      'test-env',
      'Correct event 7',
      { expectedCorrectionEventId: 7 },
    )).rejects.toThrow('one contract-valid reviewable event');

  });
});

// ── Source validation ─────────────────────────────────────────────────────────
describe('triggerAgentRun — source validation', () => {
  it('throws when source not found', async () => {
    db.default.query.mockResolvedValueOnce([[]]);
    await expect(triggerAgentRun(999, 99, 'test-key', 'test-env'))
      .rejects.toThrow('Source 999 not found or inactive');
  });
});

// ── Agent failures ────────────────────────────────────────────────────────────
describe('triggerAgentRun — agent failures', () => {
  beforeEach(setupPoolHappyPath);

  it('leaves the run resumable when one serverless monitoring slice ends', async () => {
    process.env.AGENT_RUN_TIMEOUT_MS = '1';
    mockSessionsEventsList.mockResolvedValue({
      data: [{ type: 'agent.thinking', processed_at: '2026-01-01T00:00:01Z' }],
    });

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');

    expect(result).toMatchObject({ status: 'running', pending: true });
    expect(db.default.query.mock.calls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status='failed'"),
    )).toBe(false);
  });

  it('fails a no-JSON response when this run has no direct-post evidence', async () => {
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: 'x', content: [{ type: 'text', text: 'No events found.' }] },
        { type: 'session.status_idle', created_at: 'y', stop_reason: { type: 'end_turn' } },
      ],
    });

    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('no JSON array');

    const failedUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='failed'")
    );
    expect(failedUpdate).toBeDefined();
  });

  it('accepts no JSON only when the same run has durable direct-post evidence', async () => {
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: 'x', content: [{ type: 'text', text: 'Posted through ingest.' }] },
        { type: 'session.status_idle', created_at: 'y', stop_reason: { type: 'end_turn' } },
      ],
    });
    db.default.query.mockImplementation((sql: unknown) =>
      typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
        ? Promise.resolve([[{ status: 'running' }]])
        : typeof sql === 'string' && /SELECT ar\.status, ar\.events_found/i.test(sql)
        ? Promise.resolve([[
            {
              status: 'running', events_found: 2, events_extracted: 1,
              events_skipped_dup: 1, events_errored: 0, persisted_events: 1,
            },
          ]])
        : typeof sql === 'string' && /FROM sources/i.test(sql)
        ? Promise.resolve([[SOURCE]])
        : Promise.resolve([{ affectedRows: 1 }]),
    );

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result).toMatchObject({ inserted: 1, skipped: 1, invalid: 0 });
    const completedUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='completed'")
    );
    expect(completedUpdate?.[0]).toContain("status='running'");
    expect(mockSessionsEventsSend).toHaveBeenCalledTimes(1);
  });

  it('does not treat a direct-post error counter by itself as successful output', async () => {
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: 'x', content: [{ type: 'text', text: 'Post failed.' }] },
        { type: 'session.status_idle', created_at: 'y', stop_reason: { type: 'end_turn' } },
      ],
    });
    db.default.query.mockImplementation((sql: unknown) =>
      typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
        ? Promise.resolve([[{ status: 'running' }]])
        : typeof sql === 'string' && /SELECT ar\.status, ar\.events_found/i.test(sql)
        ? Promise.resolve([[
            {
              status: 'running', events_found: 0, events_extracted: 0,
              events_skipped_dup: 0, events_errored: 1, persisted_events: 0,
            },
          ]])
        : typeof sql === 'string' && /FROM sources/i.test(sql)
        ? Promise.resolve([[SOURCE]])
        : Promise.resolve([{ affectedRows: 1 }]),
    );

    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('no direct-post output');
  });

  it('fails malformed JSON when no direct-post output exists', async () => {
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: 'x', content: [{ type: 'text', text: '[{" }]' }] },
        { type: 'session.status_idle', created_at: 'y', stop_reason: { type: 'end_turn' } },
      ],
    });

    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('malformed JSON');
    expect(mockSessionsEventsSend).toHaveBeenCalledTimes(2);
  });

  it('repairs malformed JSON once in the same session without re-running tools', async () => {
    mockSessionsEventsList
      .mockResolvedValueOnce(makeSessionText('[{"eventType":"ot",}]', 1))
      .mockResolvedValueOnce(makeSessionText(JSON.stringify([AGENT_EVENT]), 3));

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');

    expect(result).toMatchObject({ inserted: 1, invalid: 0 });
    expect(mockSessionsEventsSend).toHaveBeenCalledTimes(2);
    expect(mockSessionsEventsSend.mock.calls[1][0]).toBe('sess_xyz');
    const repairMessage = mockSessionsEventsSend.mock.calls[1][1]
      .events[0].content[0].text;
    expect(repairMessage).toContain('Do not browse again, invoke tools, or POST');
    expect(repairMessage).toContain('Correct only the event data already gathered');
    expect(repairMessage).toContain('exactly one raw JSON array');
  });

  it('caps configurable repair attempts at the hard maximum', async () => {
    process.env.AGENT_JSON_REPAIR_ATTEMPTS = '99';
    mockSessionsEventsList.mockResolvedValue(makeSessionText('[{"eventType":"ot",}]', 1));

    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('after 2 bounded repair attempts');

    expect(mockSessionsEventsSend).toHaveBeenCalledTimes(3);
    expect(mockSessionsEventsList).toHaveBeenCalledTimes(3);
  });

  it('parses separate balanced arrays without greedily merging them', async () => {
    mockSessionsEventsList.mockResolvedValue(makeSessionText(
      `Allowed values: [ot, an, jp]\n${JSON.stringify([AGENT_EVENT])}`,
      1,
    ));

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');

    expect(result.inserted).toBe(1);
    expect(mockSessionsEventsSend).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a direct post made during a repair turn', async () => {
    mockSessionsEventsList
      .mockResolvedValueOnce(makeSessionText('[{"eventType":"ot",}]', 1))
      .mockResolvedValueOnce(makeSessionText(JSON.stringify([AGENT_EVENT]), 3));
    let evidenceReads = 0;
    db.default.query.mockImplementation((sql: unknown) =>
      typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
        ? Promise.resolve([[{ status: 'running' }]])
        : typeof sql === 'string' && /SELECT ar\.status, ar\.events_found/i.test(sql)
        ? Promise.resolve([[++evidenceReads === 1
            ? {
                status: 'running', events_found: 0, events_extracted: 0,
                events_skipped_dup: 0, events_errored: 0, persisted_events: 0,
              }
            : {
                status: 'completed', events_found: 1, events_extracted: 1,
                events_skipped_dup: 0, events_errored: 0, persisted_events: 1,
              },
          ]])
        : typeof sql === 'string' && /FROM sources/i.test(sql)
        ? Promise.resolve([[SOURCE]])
        : Promise.resolve([{ affectedRows: 1 }]),
    );

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');

    expect(result).toMatchObject({ inserted: 1, skipped: 0, events: [] });
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
    expect(mockSessionsEventsSend).toHaveBeenCalledTimes(2);
  });

  it('does not persist output after the run lease has been recovered as failed', async () => {
    let statusRead = 0;
    db.default.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)) {
        statusRead++;
        return Promise.resolve([[
          { status: statusRead === 1 ? 'running' : 'failed' },
        ]]);
      }
      if (typeof sql === 'string' && /FROM sources/i.test(sql)) {
        return Promise.resolve([[SOURCE]]);
      }
      if (typeof sql === 'string' && /SELECT ar\.status, ar\.events_found/i.test(sql)) {
        return Promise.resolve([[
          {
            status: 'running', events_found: 0, events_extracted: 0,
            events_skipped_dup: 0, events_errored: 0, persisted_events: 0,
          },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('Agent run lease is no longer active');

    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
    expect(db.mockConn.query.mock.calls.some(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    )).toBe(false);
  });

  it('marks run as failed when sessions.create throws', async () => {
    mockSessionsCreate.mockRejectedValue(new Error('Rate limited'));
    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('Rate limited');

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='failed'")
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate[0]).toContain("status='running'");
  });

  it('stores error message in error_log', async () => {
    mockSessionsCreate.mockRejectedValue(new Error('Connection timeout'));
    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env')).rejects.toThrow();

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('error_log')
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate[1][0]).toContain('Connection timeout');
  });
});

// ── DB write failure → isolated item error ───────────────────────────────────
describe('triggerAgentRun — DB write failure', () => {
  it('rolls back only the failed event and completes the run with an error report', async () => {
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    db.mockConn.query
      .mockReset()
      .mockResolvedValueOnce([[]])
      .mockRejectedValueOnce(new Error('Deadlock found'));

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.inserted).toBe(0);
    expect(result.invalid).toBe(1);
    const issues = 'errors' in result ? result.errors?.[0].issues : undefined;
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'database_error',
    }));
    const completedUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='completed'")
    );
    expect(completedUpdate?.[1]?.[2]).toBe(0);
    expect(completedUpdate?.[1]?.[3]).toBe(1);
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });
});

describe('continueAgentRun — cross-invocation finalization', () => {
  const RUN = {
    ...SOURCE,
    run_id: 99,
    run_status: 'running',
    started_at: new Date(),
    session_id: 'sess_xyz',
    correction_event_id: null,
  };

  function lockConnection(acquired = 1) {
    return {
      query: jest.fn()
        .mockResolvedValueOnce([[{ acquired }]])
        .mockResolvedValueOnce([[{ released: 1 }]]),
      release: jest.fn(),
      destroy: jest.fn(),
    };
  }

  beforeEach(() => {
    db.default.query.mockReset().mockImplementation((sql: unknown) =>
      typeof sql === 'string' && /SELECT ar\.id AS run_id/i.test(sql)
        ? Promise.resolve([[RUN]])
        : typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
          ? Promise.resolve([[{ status: 'running' }]])
          : Promise.resolve([{ affectedRows: 1 }]),
    );
    db.default.getConnection.mockReset();
    db.mockConn.query
      .mockReset()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 42 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
  });

  it('paginates beyond 100 session events and persists the terminal output', async () => {
    const lock = lockConnection();
    db.default.getConnection
      .mockResolvedValueOnce(lock)
      .mockResolvedValueOnce(db.mockConn);

    const firstPage = [
      { type: 'user.message', processed_at: '2026-01-01T00:00:00Z' },
      ...Array.from({ length: 99 }, (_, index) => ({
        type: 'agent.tool_result',
        processed_at: `2026-01-01T00:00:${String(index + 1).padStart(2, '0')}Z`,
      })),
    ];
    mockSessionsEventsList
      .mockResolvedValueOnce({
        data: [{
          type: 'session.status_idle',
          processed_at: '2026-01-01T00:03:00Z',
          stop_reason: { type: 'end_turn' },
        }],
      })
      .mockResolvedValueOnce({ data: firstPage, next_page: 'page-2' })
      .mockResolvedValueOnce({
        data: [
          {
            type: 'agent.message',
            processed_at: '2026-01-01T00:02:59Z',
            content: [{ type: 'text', text: JSON.stringify([AGENT_EVENT]) }],
          },
          {
            type: 'session.status_idle',
            processed_at: '2026-01-01T00:03:00Z',
            stop_reason: { type: 'end_turn' },
          },
        ],
        next_page: null,
      });

    const result = await continueAgentRun(99, 'test-key');

    expect(result).toMatchObject({ status: 'completed', pending: false, inserted: 1 });
    expect(mockSessionsEventsList).toHaveBeenCalledWith(
      'sess_xyz',
      expect.objectContaining({ page: 'page-2', order: 'asc' }),
    );
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('returns pending while the Anthropic session is still running', async () => {
    const lock = lockConnection();
    db.default.getConnection.mockResolvedValueOnce(lock);
    mockSessionsEventsList.mockResolvedValueOnce({
      data: [{ type: 'agent.tool_use', processed_at: new Date().toISOString() }],
    });

    await expect(continueAgentRun(99, 'test-key')).resolves.toMatchObject({
      status: 'running',
      pending: true,
    });
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('does not race another continuation worker when the DB lock is busy', async () => {
    const lock = lockConnection(0);
    db.default.getConnection.mockResolvedValueOnce(lock);

    await expect(continueAgentRun(99, 'test-key')).resolves.toMatchObject({
      status: 'running',
      pending: true,
      busy: true,
    });
    expect(mockSessionsEventsList).not.toHaveBeenCalled();
  });

  it('terminates a session that exceeds the absolute runtime bound', async () => {
    const lock = lockConnection();
    db.default.getConnection.mockResolvedValueOnce(lock);
    db.default.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && /SELECT ar\.id AS run_id/i.test(sql)) {
        return Promise.resolve([[{
          ...RUN,
          started_at: new Date(Date.now() - 31 * 60_000),
        }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await continueAgentRun(99, 'test-key');

    expect(result).toMatchObject({ status: 'failed', pending: false });
    expect(mockSessionsDelete).toHaveBeenCalledWith('sess_xyz');
    expect(mockSessionsEventsList).not.toHaveBeenCalled();
  });
});

describe('monitorAgentRun — continuation lease', () => {
  it('does not start a duplicate monitor while another lease is active', async () => {
    db.default.query
      .mockReset()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[
        { run_id: 99, run_status: 'running' },
      ]]);

    await expect(monitorAgentRun(99, 'test-key', 1)).resolves.toMatchObject({
      run_id: 99,
      status: 'running',
      pending: true,
      busy: true,
    });
    expect(db.default.getConnection).not.toHaveBeenCalled();
    expect(mockSessionsEventsList).not.toHaveBeenCalled();
  });
});
