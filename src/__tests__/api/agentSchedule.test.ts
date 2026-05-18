/**
 * GET /api/agent/schedule (Vercel Cron endpoint)
 *
 * Secured by CRON_SECRET. Runs all active sources and sends
 * summary email to admin + review notifications to reviewers.
 */

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn(),
}));

jest.mock('@/lib/email', () => ({
  sendAgentRunSummary:    jest.fn().mockResolvedValue(undefined),
  sendReviewNotification: jest.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/agent/schedule/route';
import { triggerAgentRun } from '@/lib/agentRunner';
import { sendAgentRunSummary, sendReviewNotification } from '@/lib/email';

const db               = require('@/lib/db');
const mockTrigger      = triggerAgentRun as jest.Mock;
const mockSummary      = sendAgentRunSummary as jest.Mock;
const mockNotify       = sendReviewNotification as jest.Mock;

const SOURCES = [
  { id: 1, name: 'Apollo Theatre' },
  { id: 2, name: 'Oberlin College' },
];

const REVIEWER = {
  id: 10, email: 'rev@oberlin.edu', full_name: 'Jane Reviewer',
};

function makeReq(secret = 'test-cron-secret') {
  return new NextRequest('http://localhost/api/agent/schedule', {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockTrigger.mockReset();
  mockSummary.mockReset().mockResolvedValue(undefined);
  mockNotify.mockReset().mockResolvedValue(undefined);
  process.env.CRON_SECRET  = 'test-cron-secret';
  process.env.ADMIN_EMAIL  = 'admin@oberlin.edu';
});

describe('GET /api/agent/schedule', () => {
  it('returns 401 with wrong CRON_SECRET', async () => {
    const res = await GET(makeReq('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('returns 401 with missing auth header', async () => {
    const res = await GET(new NextRequest('http://localhost/api/agent/schedule', {}));
    expect(res.status).toBe(401);
  });

  it('runs all active sources and returns summary', async () => {
    db.default.query.mockResolvedValueOnce([SOURCES]); // active sources
    // Reviewer query
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    // Pending count for reviewer
    db.default.query.mockResolvedValueOnce([[{ pending: 0 }]]);

    mockTrigger
      .mockResolvedValueOnce({ inserted: 3, run_id: 1 })
      .mockResolvedValueOnce({ inserted: 5, run_id: 2 });

    const res  = await GET(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ran).toBe(2);
    expect(data.totalNew).toBe(8);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].status).toBe('ok');
    expect(data.results[1].status).toBe('ok');
  });

  it('marks source as error and continues when triggerAgentRun throws', async () => {
    db.default.query.mockResolvedValueOnce([SOURCES]);
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    db.default.query.mockResolvedValueOnce([[{ pending: 0 }]]);

    mockTrigger
      .mockRejectedValueOnce(new Error('Agent timeout'))
      .mockResolvedValueOnce({ inserted: 4, run_id: 2 });

    const data = await (await GET(makeReq())).json();

    expect(data.ran).toBe(2);
    expect(data.results[0].status).toBe('error');
    expect(data.results[0].error).toBe('Agent timeout');
    expect(data.results[1].status).toBe('ok');
  });

  it('sends admin summary email when ADMIN_EMAIL is set', async () => {
    db.default.query.mockResolvedValueOnce([SOURCES]);
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    db.default.query.mockResolvedValueOnce([[{ pending: 0 }]]);

    mockTrigger.mockResolvedValue({ inserted: 2, run_id: 1 });

    await GET(makeReq());

    // Allow the fire-and-forget to run
    await new Promise(r => setTimeout(r, 10));
    expect(mockSummary).toHaveBeenCalledWith(expect.objectContaining({
      adminEmail: 'admin@oberlin.edu',
      totalNew:   4, // 2 sources × 2 events
    }));
  });

  it('does not send admin email when ADMIN_EMAIL is not set', async () => {
    delete process.env.ADMIN_EMAIL;
    db.default.query.mockResolvedValueOnce([SOURCES]);
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    db.default.query.mockResolvedValueOnce([[{ pending: 0 }]]);
    mockTrigger.mockResolvedValue({ inserted: 1, run_id: 1 });

    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));

    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('emails reviewers when they have pending events', async () => {
    db.default.query.mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]);  // sources
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);                    // reviewers
    db.default.query.mockResolvedValueOnce([[{ pending: 7 }]]);              // pending for reviewer

    mockTrigger.mockResolvedValue({ inserted: 5, run_id: 1 });

    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      reviewerEmail: REVIEWER.email,
      pendingCount:  7,
    }));
  });

  it('does not email reviewers when they have no pending events', async () => {
    db.default.query.mockResolvedValueOnce([[{ id: 1, name: 'Apollo' }]]);
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    db.default.query.mockResolvedValueOnce([[{ pending: 0 }]]);

    mockTrigger.mockResolvedValue({ inserted: 0, run_id: 1 });

    await GET(makeReq());
    await new Promise(r => setTimeout(r, 10));

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('handles empty sources list gracefully', async () => {
    db.default.query.mockResolvedValueOnce([[]]); // no active sources
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    db.default.query.mockResolvedValueOnce([[{ pending: 0 }]]);

    const data = await (await GET(makeReq())).json();

    expect(data.ran).toBe(0);
    expect(data.totalNew).toBe(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
