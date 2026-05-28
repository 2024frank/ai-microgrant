jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn().mockResolvedValue({ run_id: 55, inserted: 0 }),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/review/events/[id]/send-for-correction/route';
import { triggerAgentRun } from '@/lib/agentRunner';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const USER = {
  id: 1,
  email: 'reviewer@oberlin.edu',
  role: 'reviewer',
  full_name: 'Reviewer',
  active: 1,
  firebase_uid: 'uid-reviewer',
};

const EVENT = {
  id: 42,
  source_id: 3,
  title: 'Needs Fix',
  status: 'pending',
  calendar_source_url: 'https://example.edu/event',
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq() {
  return new NextRequest('http://localhost/api/review/events/42/send-for-correction', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ correction_notes: 'Missing phone number' }),
  });
}

beforeEach(() => {
  process.env.INGEST_SECRET = 'global-ingest-secret';
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
  (triggerAgentRun as jest.Mock).mockClear();
});

describe('POST /api/review/events/:id/send-for-correction', () => {
  it('passes a scoped fix token to the agent prompt without leaking INGEST_SECRET', async () => {
    db.default.query
      .mockResolvedValueOnce([[USER]])
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ id: USER.id, email: USER.email }]])
      .mockResolvedValueOnce([{ insertId: 55 }]);

    const res = await POST(makeReq(), ctx('42'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(triggerAgentRun).toHaveBeenCalledTimes(1);
    const fixMessage = (triggerAgentRun as jest.Mock).mock.calls[0][4];
    expect(fixMessage).toContain('Header: x-fix-token:');
    expect(fixMessage).toContain('"fixedFromEventId": "42"');
    expect(fixMessage).not.toContain('global-ingest-secret');
    expect(fixMessage).not.toContain('x-ingest-secret');
  });
});
