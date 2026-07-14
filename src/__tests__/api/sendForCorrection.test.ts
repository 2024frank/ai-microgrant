jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn(),
}));

import { after, NextRequest } from 'next/server';
import { POST } from '@/app/api/review/events/[id]/send-for-correction/route';
import { adminAuth } from '@/lib/firebase-admin';
import { triggerAgentRun } from '@/lib/agentRunner';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockAfter = after as jest.Mock;
const mockTrigger = triggerAgentRun as jest.Mock;

const ADMIN = {
  id: 1,
  email: 'admin@oberlin.edu',
  role: 'admin',
  active: 1,
  firebase_uid: 'uid-admin',
};
const REVIEWER = {
  id: 2,
  email: 'reviewer@oberlin.edu',
  role: 'reviewer',
  active: 1,
  firebase_uid: 'uid-reviewer',
};
const EVENT = {
  id: 10,
  source_id: 3,
  source_active: 1,
  status: 'pending',
  title: 'Community Concert',
  description: 'A community concert in Oberlin.',
  event_type: 'ot',
  sponsors: '["Arts Council"]',
  post_type_ids: '[8]',
  sessions: '[{"startTime":1800000000,"endTime":1800003600}]',
  location_type: 'ph2',
  location: 'Tappan Square',
  calendar_source_name: 'Arts Council',
  calendar_source_url: 'https://example.org/events/concert',
};

function request(notes = 'The start time should be 8 PM.') {
  return new NextRequest('http://localhost/api/review/events/10/send-for-correction', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ correction_notes: notes }),
  });
}

const context = { params: Promise.resolve({ id: '10' }) };

describe('POST /api/review/events/:id/send-for-correction', () => {
  const callbacks: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.SOURCE_BUILDER_ENVIRONMENT_ID = 'test-env';
    process.env.INGEST_SECRET = 'must-not-appear-in-a-prompt';
    db.default.query.mockReset();
    db.default.getConnection.mockClear();
    db.mockConn.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release = jest.fn();
    mockVerify.mockReset().mockResolvedValue({ uid: 'uid-admin', email: ADMIN.email });
    mockTrigger.mockReset().mockResolvedValue({ run_id: 44, inserted: 1, events: [] });
    callbacks.length = 0;
    mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
      callbacks.push(callback);
    });
  });

  function successfulClaim(correctionApplied = true) {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ id: 1, email: ADMIN.email }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ insertId: 44 }]);
    if (correctionApplied) {
      db.default.query.mockResolvedValueOnce([[{ id: 55 }]]);
    }
  }

  it('runs the event source agent with no secret embedded in the prompt', async () => {
    successfulClaim();

    const response = await POST(request(), context);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.fix_run_id).toBe(44);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockTrigger).not.toHaveBeenCalled();

    await callbacks[0]();
    expect(mockTrigger).toHaveBeenCalledWith(
      EVENT.source_id,
      44,
      'test-key',
      'test-env',
      expect.stringContaining('fixedFromEventId'),
      { expectedCorrectionEventId: EVENT.id },
    );
    const prompt = mockTrigger.mock.calls[0][4] as string;
    expect(prompt).toContain('untrusted data');
    expect(prompt).not.toContain(process.env.INGEST_SECRET);
    expect(prompt).not.toContain('x-ingest-secret');
  });

  it('does not mutate the event when the source run lease is already held', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ id: 1, email: ADMIN.email }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockRejectedValueOnce(duplicate);

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(db.default.getConnection).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('enforces reviewer source assignments before claiming a run', async () => {
    mockVerify.mockResolvedValue({ uid: REVIEWER.firebase_uid, email: REVIEWER.email });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('returns the original event to manual review when no corrected draft is produced', async () => {
    successfulClaim(false);
    mockTrigger.mockResolvedValueOnce({ run_id: 44, inserted: 0, events: [] });
    db.default.query.mockResolvedValue([{ affectedRows: 1 }]);
    db.default.query.mockResolvedValueOnce([[]]);

    await POST(request(), context);
    await callbacks[0]();

    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining("status='pending'"),
      [EVENT.id],
    );
    expect(db.default.query).toHaveBeenCalledWith(
      'DELETE FROM needs_fix WHERE raw_event_id=?',
      [EVENT.id],
    );
  });
});
