jest.mock('@/lib/agentRunner', () => ({ triggerAgentRun: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendAgentRunSummary:    jest.fn().mockResolvedValue(undefined),
  sendReviewNotification: jest.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/agent/schedule/route';
import { triggerAgentRun }       from '@/lib/agentRunner';
import { sendAgentRunSummary, sendReviewNotification } from '@/lib/email';

const db          = require('@/lib/db');
const mockTrigger = triggerAgentRun as jest.Mock;
const mockSummary = sendAgentRunSummary as jest.Mock;
const mockNotify  = sendReviewNotification as jest.Mock;

const TWO_SOURCES = [{ id: 1, name: 'Apollo Theatre' }, { id: 2, name: 'Oberlin College' }];
const ONE_SOURCE  = [{ id: 1, name: 'Apollo' }];
const REVIEWER    = { id: 10, email: 'rev@oberlin.edu', full_name: 'Jane Reviewer' };

function makeReq(secret = 'test-cron-secret') {
  return new NextRequest('http://localhost/api/agent/schedule', {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

// Helper: set up pool mocks for N sources
// Route does: [sources] + per-source [INSERT agent_runs, optional failure UPDATE]
// + (if totalNew>0) [reviewers] + N×[pending per reviewer]
function mockForSources(sources: any[], triggerResults: any[], reviewerPending = 0) {
  db.default.query.mockReset();
  db.default.query.mockResolvedValueOnce([sources]); // active sources query

  for (let i = 0; i < sources.length; i++) {
    db.default.query.mockResolvedValueOnce([{ insertId: i + 1 }]);
    if (triggerResults[i] instanceof Error) {
      db.default.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    }
  }

  // reviewers + pending (only if at least one source succeeds)
  const totalNew = triggerResults.reduce((s, r) => s + (r?.inserted || 0), 0);
  if (totalNew > 0) {
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    db.default.query.mockResolvedValueOnce([[{ pending: reviewerPending }]]);
  }
  // Set up triggerAgentRun mocks
  mockTrigger.mockReset();
  triggerResults.forEach(r => {
    if (r instanceof Error) mockTrigger.mockRejectedValueOnce(r);
    else mockTrigger.mockResolvedValueOnce(r);
  });
}

beforeEach(() => {
  mockSummary.mockReset().mockResolvedValue(undefined);
  mockNotify.mockReset().mockResolvedValue(undefined);
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.ADMIN_EMAIL = 'admin@oberlin.edu';
});

describe('GET /api/agent/schedule', () => {
  it('returns 401 with wrong CRON_SECRET', async () => {
    expect((await GET(makeReq('wrong'))).status).toBe(401);
  });

  it('returns 401 with missing auth header', async () => {
    expect((await GET(new NextRequest('http://localhost/api/agent/schedule', {}))).status).toBe(401);
  });

  it('runs all active sources and returns summary', async () => {
    mockForSources(TWO_SOURCES, [{ inserted: 3, run_id: 1 }, { inserted: 5, run_id: 2 }], 0);
    const data = await (await GET(makeReq())).json();
    expect(data.ran).toBe(2);
    expect(data.totalNew).toBe(8);
    expect(data.results[0].status).toBe('ok');
    expect(data.results[1].status).toBe('ok');
  });

  it('marks source as error and continues when triggerAgentRun throws', async () => {
    mockForSources(TWO_SOURCES, [new Error('Agent timeout'), { inserted: 4, run_id: 2 }], 0);
    const data = await (await GET(makeReq())).json();
    expect(data.ran).toBe(2);
    expect(data.results[0].status).toBe('error');
    expect(data.results[0].error).toBe('Agent timeout');
    expect(data.results[1].status).toBe('ok');
  });

  it('sends admin summary email when ADMIN_EMAIL is set', async () => {
    mockForSources(TWO_SOURCES, [{ inserted: 2, run_id: 1 }, { inserted: 2, run_id: 2 }], 0);
    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));
    expect(mockSummary).toHaveBeenCalledWith(expect.objectContaining({
      adminEmail: 'admin@oberlin.edu', totalNew: 4,
    }));
  });

  it('does not send admin email when ADMIN_EMAIL is not set', async () => {
    delete process.env.ADMIN_EMAIL;
    mockForSources(ONE_SOURCE, [{ inserted: 1, run_id: 1 }], 0);
    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('emails reviewers when they have pending events', async () => {
    mockForSources(ONE_SOURCE, [{ inserted: 5, run_id: 1 }], 7);
    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      reviewerEmail: REVIEWER.email, pendingCount: 7,
    }));
  });

  it('does not email reviewers when they have no pending events', async () => {
    mockForSources(ONE_SOURCE, [{ inserted: 0, run_id: 1 }], 0);
    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('handles empty sources list gracefully', async () => {
    db.default.query.mockReset();
    db.default.query.mockResolvedValueOnce([[]]); // no active sources
    mockTrigger.mockReset();
    const data = await (await GET(makeReq())).json();
    expect(data.ran).toBe(0);
    expect(data.totalNew).toBe(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
