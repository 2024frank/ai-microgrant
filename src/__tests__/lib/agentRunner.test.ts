/**
 * agentRunner — unit tests
 * Mocks the Anthropic Sessions API used by the current implementation.
 */

// ── Mock Anthropic SDK ──────────────────────────────────────────────────────
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
  getRejectionHistory: jest.fn(),
}));

import { triggerAgentRun }   from '@/lib/agentRunner';
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
  sponsors: ['Apollo Theatre'], postTypeId: [8],
  sessions: [{ startTime: 1700000000, endTime: 1700003600 }],
  locationType: 'ph2', location: '19 E College St, Oberlin, OH 44074',
  geo_scope: 'city_wide',
};

// Build a Sessions API event list response that includes an agent.message
// with JSON output, followed by session.status_idle
function makeSessionEvents(events: object[] = [AGENT_EVENT]) {
  return {
    data: [
      {
        type: 'agent.message',
        created_at: '2026-01-01T00:00:01Z',
        content: [{ type: 'text', text: JSON.stringify(events) }],
      },
      {
        type: 'session.status_idle',
        created_at: '2026-01-01T00:00:02Z',
        stop_reason: { type: 'end_turn' },
      },
    ],
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

  mockGetHistory.mockResolvedValue({ count: 0, prompt_block: '' });

  mockSessionsCreate.mockResolvedValue({ id: 'sess_xyz' });
  mockSessionsEventsSend.mockResolvedValue({});
  mockSessionsEventsList.mockResolvedValue(makeSessionEvents());

  db.mockConn.query
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
    .mockResolvedValueOnce([[{ status: 'running' }]]) // stop-status poll
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
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('events_found')
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
  it('inserts all events in one transaction', async () => {
    const events = [
      { ...AGENT_EVENT, title: 'Event A' },
      { ...AGENT_EVENT, title: 'Event B' },
      { ...AGENT_EVENT, title: 'Event C' },
    ];
    mockSessionsEventsList.mockResolvedValue(makeSessionEvents(events));

    db.mockConn.query
      .mockReset()
      .mockResolvedValueOnce([{ insertId: 10 }]).mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 11 }]).mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 12 }]).mockResolvedValueOnce([{ affectedRows: 1 }]);

    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([[{ status: 'running' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.inserted).toBe(3);
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
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

  it('treats no-JSON agent response as a direct-post run (success, 0 events)', async () => {
    mockSessionsEventsList.mockResolvedValue({
      data: [
        { type: 'agent.message', created_at: 'x', content: [{ type: 'text', text: 'No events found.' }] },
        { type: 'session.status_idle', created_at: 'y', stop_reason: { type: 'end_turn' } },
      ],
    });

    const result = await triggerAgentRun(1, 99, 'test-key', 'test-env');
    expect(result.inserted).toBe(0);
    expect(result.events).toHaveLength(0);

    const completedUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='completed'")
    );
    expect(completedUpdate).toBeDefined();
  });

  it('marks run as failed when sessions.create throws', async () => {
    mockSessionsCreate.mockRejectedValueOnce(new Error('Rate limited'));
    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env'))
      .rejects.toThrow('Rate limited');

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='failed'")
    );
    expect(failUpdate).toBeDefined();
  });

  it('stores error message in error_log', async () => {
    mockSessionsCreate.mockRejectedValueOnce(new Error('Connection timeout'));
    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env')).rejects.toThrow();

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('error_log')
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate[1][0]).toContain('Connection timeout');
  });
});

// ── DB write failure → rollback ───────────────────────────────────────────────
describe('triggerAgentRun — DB write failure', () => {
  it('rolls back transaction and marks run failed when conn.query throws', async () => {
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([[{ status: 'running' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    db.mockConn.query.mockReset();
    db.mockConn.query.mockRejectedValueOnce(new Error('Deadlock found'));

    await expect(triggerAgentRun(1, 99, 'test-key', 'test-env')).rejects.toThrow();
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });
});
