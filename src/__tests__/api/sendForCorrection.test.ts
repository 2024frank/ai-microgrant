import { NextRequest } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn(),
}));

import { POST } from '@/app/api/review/events/[id]/send-for-correction/route';
import { triggerAgentRun } from '@/lib/agentRunner';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockTriggerAgentRun = triggerAgentRun as jest.Mock;

const AUTH_USER = {
  id: 10,
  email: 'reviewer@oberlin.edu',
  role: 'reviewer',
  full_name: 'Reviewer',
  active: 1,
  firebase_uid: 'uid-reviewer',
};

const EVENT = {
  id: 123,
  source_id: 2,
  title: 'Needs Better Details',
  status: 'pending',
  calendar_source_url: 'https://example.com/event',
};

const DB_USER = {
  id: 10,
  email: 'reviewer@oberlin.edu',
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(body: any) {
  return new NextRequest('http://localhost/api/review/events/123/send-for-correction', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setupQueries(remainingFixRow: boolean) {
  db.default.query.mockImplementation((sql: string) => {
    if (sql.includes('SELECT * FROM users WHERE email')) {
      return Promise.resolve([[AUTH_USER]]);
    }
    if (sql.includes('SELECT id, source_id, title, status')) {
      return Promise.resolve([[EVENT]]);
    }
    if (sql.includes('SELECT id, email FROM users WHERE firebase_uid')) {
      return Promise.resolve([[DB_USER]]);
    }
    if (sql.includes('INSERT INTO agent_runs')) {
      return Promise.resolve([{ insertId: 456 }]);
    }
    if (sql.includes('SELECT 1 FROM needs_fix')) {
      return Promise.resolve(remainingFixRow ? [[{ found: 1 }]] : [[]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
}

async function waitForAsyncWork(assertion: () => boolean) {
  for (let i = 0; i < 30; i++) {
    if (assertion()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for async route work');
}

beforeEach(() => {
  process.env.INGEST_SECRET = 'test-ingest-secret';
  jest.spyOn(console, 'error').mockImplementation(() => {});

  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();

  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
  mockTriggerAgentRun.mockReset();
  mockTriggerAgentRun.mockResolvedValue({ run_id: 456, inserted: 0, events: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/review/events/:id/send-for-correction', () => {
  it('returns the event to the queue if the fix agent completes without clearing needs_fix', async () => {
    setupQueries(true);

    const res = await POST(
      makeReq({ correction_notes: 'Missing contact details.' }),
      ctx('123')
    );

    expect(res.status).toBe(200);
    expect((await res.json()).fix_run_id).toBe(456);

    await waitForAsyncWork(() =>
      db.default.query.mock.calls.some((call: any[]) =>
        typeof call[0] === 'string' && call[0].includes("UPDATE raw_events SET status='pending'")
      )
    );

    expect(mockTriggerAgentRun).toHaveBeenCalledWith(
      6,
      456,
      'test-key',
      'env-test',
      expect.stringContaining('"fixedFromEventId": "123"')
    );
    expect(db.default.query.mock.calls.some((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes("UPDATE agent_runs SET status='failed'")
    )).toBe(true);
    expect(db.default.query.mock.calls.some((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes("VALUES (?, 'fix_failed'")
    )).toBe(true);
  });

  it('does not recover a fix run when the corrected ingest clears needs_fix', async () => {
    setupQueries(false);

    const res = await POST(
      makeReq({ correction_notes: 'Missing contact details.' }),
      ctx('123')
    );

    expect(res.status).toBe(200);

    await waitForAsyncWork(() =>
      db.default.query.mock.calls.some((call: any[]) =>
        typeof call[0] === 'string' && call[0].includes('SELECT 1 FROM needs_fix')
      )
    );

    expect(db.default.query.mock.calls.some((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes("UPDATE raw_events SET status='pending'")
    )).toBe(false);
    expect(db.default.query.mock.calls.some((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes("UPDATE agent_runs SET status='failed'")
    )).toBe(false);
  });
});
