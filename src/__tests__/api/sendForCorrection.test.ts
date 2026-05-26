jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn().mockResolvedValue({ run_id: 123, inserted: 0, events: [] }),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/review/events/[id]/send-for-correction/route';
import { adminAuth } from '@/lib/firebase-admin';
import { triggerAgentRun } from '@/lib/agentRunner';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockTrigger = triggerAgentRun as jest.Mock;

const REVIEWER = {
  id: 7,
  email: 'reviewer@oberlin.edu',
  role: 'reviewer',
  full_name: 'Reviewer',
  active: 1,
  firebase_uid: 'uid-reviewer',
};

const EVENT = {
  id: 10,
  source_id: 2,
  title: 'Jazz Night',
  status: 'pending',
  calendar_source_url: 'https://example.org/jazz',
};

function makeReq() {
  return new NextRequest('http://localhost/api/review/events/10/send-for-correction', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ correction_notes: 'Add the missing phone number.' }),
  });
}

function ctx(id = '10') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  db.default.query.mockReset();
  db.default.getConnection.mockClear();
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: REVIEWER.firebase_uid, email: REVIEWER.email });
  mockTrigger.mockClear();
  mockTrigger.mockResolvedValue({ run_id: 123, inserted: 0, events: [] });
});

describe('POST /api/review/events/:id/send-for-correction', () => {
  it('creates the fix agent run with the configured fixed-events source id', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]]) // getAuthUser
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ id: 42 }]]) // fixed-events source lookup
      .mockResolvedValueOnce([[{ id: REVIEWER.id, email: REVIEWER.email }]]);

    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO agent_runs')) return Promise.resolve([{ insertId: 123 }]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const res = await POST(makeReq(), ctx());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.fix_run_id).toBe(123);

    const runInsert = db.mockConn.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO agent_runs')
    );
    expect(runInsert).toBeDefined();
    expect(runInsert[1]).toEqual([42]);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockTrigger).toHaveBeenCalledWith(
      42,
      123,
      process.env.ANTHROPIC_API_KEY,
      process.env.SOURCE_BUILDER_ENVIRONMENT_ID,
      expect.stringContaining('raw_event_id: 10')
    );
  });

  it('does not mark the event pending_fix when fixed-events source is missing', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]]) // getAuthUser
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[]]); // fixed-events source lookup

    const res = await POST(makeReq(), ctx());
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain('Fixed Events source');
    expect(db.default.getConnection).not.toHaveBeenCalled();
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
