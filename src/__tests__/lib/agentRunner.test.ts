/**
 * agentRunner — unit tests
 *
 * All I/O boundaries mocked:
 *   - @anthropic-ai/sdk  → mockCreate / mockRetrieve
 *   - @/lib/db           → pool.query + pool.getConnection (from global setup)
 *   - @/lib/rejectionHistory → getRejectionHistory
 */

// ---------------------------------------------------------------------------
// Mock Anthropic SDK before importing the module under test
// ---------------------------------------------------------------------------
const mockCreate   = jest.fn();
const mockRetrieve = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    beta: { agents: { runs: { create: mockCreate, retrieve: mockRetrieve } } },
  })),
}));

jest.mock('@/lib/rejectionHistory', () => ({
  getRejectionHistory: jest.fn(),
}));

import { triggerAgentRun } from '@/lib/agentRunner';
import { getRejectionHistory } from '@/lib/rejectionHistory';

const db              = require('@/lib/db');
const mockGetHistory  = getRejectionHistory as jest.Mock;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const SOURCE = {
  id: 1, name: 'Apollo Theatre', agent_id: 'agt_abc', active: 1,
  calendar_source_name: 'Apollo Theatre',
};

const AGENT_EVENT = {
  eventType: 'ot',
  title:     'Jazz Night',
  description: 'Live jazz at Apollo.',
  sponsors:  ['Apollo Theatre'],
  postTypeId: [8],
  sessions:  [{ startTime: 1700000000, endTime: 1700003600 }],
  locationType: 'ph2',
  location:  '19 E College St, Oberlin, OH 44074',
  geo_scope: 'city_wide',
};

function makeAgentResult(events: object[] = [AGENT_EVENT]) {
  return {
    id:              'run_xyz',
    status:          'completed',
    output_messages: [
      { role: 'assistant', content: JSON.stringify(events) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();

  // Default: no rejection history
  mockGetHistory.mockResolvedValue({ count: 0, prompt_block: '' });

  // Default conn.query: INSERT raw_events → insertId 42, then UPDATE ingested_post_url
  db.mockConn.query
    .mockResolvedValueOnce([{ insertId: 42 }])   // INSERT raw_events
    .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE ingested_post_url
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe('triggerAgentRun — happy path', () => {
  beforeEach(() => {
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])           // sources SELECT
      .mockResolvedValueOnce([{ insertId: 99 }])  // INSERT agent_runs → runId=99
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE agent_runs completed

    mockCreate.mockResolvedValue(makeAgentResult());
  });

  it('returns run_id, inserted count, and event list', async () => {
    const result = await triggerAgentRun(1);
    expect(result.run_id).toBe(99);
    expect(result.inserted).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('Jazz Night');
  });

  it('passes agent_id, environment_id, vault_id to Anthropic', async () => {
    await triggerAgentRun(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      agent_id:       SOURCE.agent_id,
      environment_id: process.env.SOURCE_BUILDER_ENVIRONMENT_ID,
      vault_id:       process.env.SOURCE_BUILDER_VAULT_ID,
    }));
  });

  it('builds ingestedPostUrl using APP_URL and inserted row id', async () => {
    await triggerAgentRun(1);
    const updateCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('ingested_post_url')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toContain('http://localhost:3000/events/42');
  });

  it('updates agent_run with events_found and events_extracted', async () => {
    await triggerAgentRun(1);
    const updateCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('events_found')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual([1, 1, 99]); // found=1, extracted=1, runId=99
  });

  it('injects rejection history into agent message when available', async () => {
    mockGetHistory.mockResolvedValueOnce({
      count: 3,
      prompt_block: '## Rejection history\n- "Old Event" → REJECTED: wrong_audience',
    });
    await triggerAgentRun(1);
    const msg = mockCreate.mock.calls[0][0].messages[0].content;
    expect(msg).toContain('Rejection history');
    expect(msg).toContain('Old Event');
  });

  it('sends plain message when no rejection history', async () => {
    await triggerAgentRun(1);
    const msg = mockCreate.mock.calls[0][0].messages[0].content;
    expect(msg).toContain('Run extraction now');
    expect(msg).not.toContain('Rejection history');
  });

  it('queries rejection history with correct sourceId and limit=50', async () => {
    await triggerAgentRun(1);
    expect(mockGetHistory).toHaveBeenCalledWith(1, 50);
  });

  it('wraps writeEvents in a transaction (beginTransaction + commit)', async () => {
    await triggerAgentRun(1);
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
    expect(db.mockConn.rollback).not.toHaveBeenCalled();
  });

  it('releases the DB connection after success', async () => {
    await triggerAgentRun(1);
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple events
// ---------------------------------------------------------------------------
describe('triggerAgentRun — multiple events', () => {
  it('inserts all events in one transaction — O(n) DB writes', async () => {
    const events = [
      { ...AGENT_EVENT, title: 'Event A' },
      { ...AGENT_EVENT, title: 'Event B' },
      { ...AGENT_EVENT, title: 'Event C' },
    ];
    // Provide 3 pairs of (INSERT + UPDATE) conn.query results
    db.mockConn.query
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 11 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 12 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ insertId: 99 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    mockCreate.mockResolvedValue(makeAgentResult(events));

    const result = await triggerAgentRun(1);
    expect(result.inserted).toBe(3);
    expect(result.events).toHaveLength(3);
    // Exactly one transaction for all inserts — not one per event
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Source validation
// ---------------------------------------------------------------------------
describe('triggerAgentRun — source validation', () => {
  it('throws when source not found', async () => {
    db.default.query.mockResolvedValueOnce([[]]); // empty result
    await expect(triggerAgentRun(999)).rejects.toThrow('Source 999 not found or inactive');
  });
});

// ---------------------------------------------------------------------------
// Agent failure modes
// ---------------------------------------------------------------------------
describe('triggerAgentRun — agent failures', () => {
  beforeEach(() => {
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ insertId: 99 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE failed
  });

  it('marks run as failed when agent returns non-completed status', async () => {
    mockCreate.mockResolvedValue({ id: 'run_xyz', status: 'failed' });

    await expect(triggerAgentRun(1)).rejects.toThrow('Agent run ended with status: failed');

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='failed'")
    );
    expect(failUpdate).toBeDefined();
  });

  it('marks run as failed when agent output has no JSON array', async () => {
    mockCreate.mockResolvedValue({
      id: 'run_xyz', status: 'completed',
      output_messages: [{ role: 'assistant', content: 'Sorry, could not find events.' }],
    });

    await expect(triggerAgentRun(1)).rejects.toThrow('Agent returned no JSON array');

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='failed'")
    );
    expect(failUpdate).toBeDefined();
  });

  it('marks run as failed when Anthropic SDK throws', async () => {
    mockCreate.mockRejectedValue(new Error('Rate limited'));

    await expect(triggerAgentRun(1)).rejects.toThrow('Rate limited');

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status='failed'")
    );
    expect(failUpdate).toBeDefined();
  });

  it('stores error message in error_log JSON column', async () => {
    mockCreate.mockRejectedValue(new Error('Connection timeout'));

    await expect(triggerAgentRun(1)).rejects.toThrow();

    const failUpdate = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('error_log')
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate[1][0]).toContain('Connection timeout');
  });
});

// ---------------------------------------------------------------------------
// DB write failure → rollback
// ---------------------------------------------------------------------------
describe('triggerAgentRun — DB write failure', () => {
  it('rolls back transaction and marks run failed when conn.query throws', async () => {
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ insertId: 99 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // failed update

    mockCreate.mockResolvedValue(makeAgentResult());

    // Clear the beforeEach queue and replace with an immediate rejection
    db.mockConn.query.mockReset();
    db.mockConn.query.mockRejectedValueOnce(new Error('Deadlock found'));

    await expect(triggerAgentRun(1)).rejects.toThrow();
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });
});
