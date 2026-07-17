jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn(),
}));

jest.mock('@/lib/agentContinuation', () => ({
  enqueueAgentContinuation: jest.fn(),
}));

import { after, NextRequest } from 'next/server';
import { POST } from '@/app/api/agent/system-corrections/route';
import { triggerAgentRun } from '@/lib/agentRunner';
import { enqueueAgentContinuation } from '@/lib/agentContinuation';

const db = require('@/lib/db');
const mockAfter = after as jest.Mock;
const mockTriggerAgentRun = triggerAgentRun as jest.Mock;
const mockEnqueueContinuation = enqueueAgentContinuation as jest.Mock;

const CANDIDATE = {
  id: 10,
  source_id: 4,
  title: 'Broken Event',
  status: 'rejected',
  sent_for_correction: 0,
  rejection_reason_codes: '["missing_fields"]',
  rejection_reviewer_note: 'Location and time are absent from the draft.',
};

function request(secret = 'test-cron-secret') {
  return new NextRequest('http://localhost/api/agent/system-corrections', {
    method: 'POST',
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

describe('POST /api/agent/system-corrections', () => {
  const callbacks: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
    db.default.getConnection.mockClear();
    db.mockConn.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release = jest.fn();
    mockTriggerAgentRun.mockReset().mockResolvedValue({ pending: false });
    mockEnqueueContinuation.mockReset().mockResolvedValue(undefined);
    callbacks.length = 0;
    mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
      callbacks.push(callback);
    });
  });

  it('rejects requests without the cron secret', async () => {
    const response = await POST(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'CRON_SECRET is not configured' });
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('dispatches a correction run for a system-rejected candidate', async () => {
    db.default.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM raw_events re')) {
        return Promise.resolve([[CANDIDATE]]);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO agent_runs')) {
        return Promise.resolve([{ insertId: 55 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      considered: 1,
      dispatched: 1,
      results: [{ event_id: 10, status: 'dispatched', run_id: 55 }],
    });

    // The run is claimed against the event before any queue writes.
    const runInsert = db.default.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO agent_runs'),
    );
    expect(runInsert).toBeDefined();
    expect(runInsert[1]).toEqual([4, 10]);

    // needs_fix is upserted with the required-field correction notes.
    const needsFixInsert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO needs_fix'),
    );
    expect(needsFixInsert).toBeDefined();
    expect(needsFixInsert[1][0]).toBe(10);
    expect(needsFixInsert[1][1]).toBe(4);
    expect(needsFixInsert[1][2]).toContain('Required fields are missing');
    expect(needsFixInsert[1][2]).toContain('Location and time are absent');

    // The event is flipped to sent_for_correction and the action is logged.
    const claimUpdate = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('sent_for_correction=1'),
    );
    expect(claimUpdate).toBeDefined();
    expect(claimUpdate[1]).toEqual([10]);
    const reviewSessionInsert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO review_sessions'),
    );
    expect(reviewSessionInsert).toBeDefined();
    expect(reviewSessionInsert[1]).toEqual([10]);
    expect(db.mockConn.commit).toHaveBeenCalled();
    expect(db.mockConn.release).toHaveBeenCalled();

    // The agent trigger is deferred through after() and targets the claimed run.
    expect(callbacks).toHaveLength(1);
    expect(mockTriggerAgentRun).not.toHaveBeenCalled();
    await callbacks[0]();
    expect(mockTriggerAgentRun).toHaveBeenCalledWith(
      4,
      55,
      'test-key',
      'env-test',
      expect.stringContaining('"fixedFromEventId": "10"'),
      { expectedCorrectionEventId: 10 },
    );
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
  });

  it('skips a candidate when the run claim hits a duplicate-key conflict', async () => {
    db.default.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM raw_events re')) {
        return Promise.resolve([[CANDIDATE]]);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO agent_runs')) {
        return Promise.reject({ code: 'ER_DUP_ENTRY' });
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      considered: 1,
      dispatched: 0,
      results: [{ event_id: 10, status: 'skipped' }],
    });

    // The transaction never starts, so no needs_fix write happens.
    expect(db.default.getConnection).not.toHaveBeenCalled();
    expect(db.mockConn.query).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('marks the run failed when the event can no longer be claimed', async () => {
    db.default.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM raw_events re')) {
        return Promise.resolve([[CANDIDATE]]);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO agent_runs')) {
        return Promise.resolve([{ insertId: 55 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('sent_for_correction=1')) {
        return Promise.resolve([{ affectedRows: 0 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      considered: 1,
      dispatched: 0,
      results: [{
        event_id: 10,
        status: 'error',
        run_id: 55,
        error: 'Event is no longer available for correction',
      }],
    });

    // The transaction is rolled back before the review_sessions write.
    expect(db.mockConn.rollback).toHaveBeenCalled();
    expect(db.mockConn.commit).not.toHaveBeenCalled();
    expect(db.mockConn.release).toHaveBeenCalled();
    expect(db.mockConn.query.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO review_sessions'),
    )).toBe(false);

    // The claimed run is marked failed with the queue error recorded.
    const runFailUpdate = db.default.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET status='failed'"),
    );
    expect(runFailUpdate).toBeDefined();
    expect(runFailUpdate[1][0]).toContain('Event is no longer available for correction');
    expect(runFailUpdate[1][1]).toBe(55);

    // No agent run is triggered for the failed dispatch.
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
