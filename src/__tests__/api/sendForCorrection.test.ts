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
import { POST } from '@/app/api/review/events/[id]/send-for-correction/route';
import { adminAuth } from '@/lib/firebase-admin';
import { triggerAgentRun } from '@/lib/agentRunner';
import { enqueueAgentContinuation } from '@/lib/agentContinuation';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockAfter = after as jest.Mock;
const mockTrigger = triggerAgentRun as jest.Mock;
const mockEnqueue = enqueueAgentContinuation as jest.Mock;

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
    mockEnqueue.mockReset().mockResolvedValue(undefined);
    callbacks.length = 0;
    mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
      callbacks.push(callback);
    });
  });

  function successfulClaim(correctionApplied = true, sourceEvent = EVENT) {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[sourceEvent]])
      .mockResolvedValueOnce([[{ id: 1, email: ADMIN.email }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ insertId: 44 }]);
    if (correctionApplied) {
      db.default.query.mockResolvedValueOnce([[{ id: 55 }]]);
    }
  }

  function correctionCleanup(status: 'pending_fix' | 'rejected', newerRun = false) {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('JOIN agent_runs owner')) {
        return Promise.resolve([[
          { id: EVENT.id, source_id: EVENT.source_id, status, sent_for_correction: 1 },
        ]]);
      }
      if (sql.includes('id<>?') && sql.includes('agent_runs')) {
        return Promise.resolve(newerRun ? [[{ id: 45 }]] : [[]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
  }

  it('runs the event source agent with no secret embedded in the prompt', async () => {
    successfulClaim();

    const response = await POST(request(), context);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.fix_run_id).toBe(44);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('correction_notes'),
      [EVENT.id.toString(), EVENT.source_id, 'The start time should be 8 PM.', ADMIN.id, ADMIN.email],
    );

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

  it('keeps a correction claimed while its managed-agent session awaits continuation', async () => {
    successfulClaim(false);
    mockTrigger.mockResolvedValueOnce({
      run_id: 44,
      status: 'running',
      pending: true,
      inserted: 0,
      skipped: 0,
      invalid: 0,
      events: [],
    });

    const response = await POST(request(), context);
    expect(response.status).toBe(202);
    const failureWritesBeforeContinuation = db.default.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status='failed'"),
    ).length;

    await callbacks[0]();

    expect(db.default.query.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('JOIN agent_runs owner'),
    )).toBe(false);
    expect(db.default.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status='failed'"),
    )).toHaveLength(failureWritesBeforeContinuation);
    expect(mockEnqueue).toHaveBeenCalledWith('http://localhost:3000', [44]);
  });

  it('turns a rejected record into a corrected draft and includes its rejection evidence', async () => {
    const rejectedEvent = {
      ...EVENT,
      status: 'rejected',
      rejection_reason_codes: JSON.stringify(['bad_date_parse', 'bad_location']),
      rejection_reviewer_note: 'The source shows Sunday at ForeFront Field.',
    };
    successfulClaim(true, rejectedEvent);

    const response = await POST(request('Re-open the source and correct only supported facts.'), context);

    expect(response.status).toBe(202);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id=? AND status=?'),
      ['rejected', '10', 'rejected'],
    );

    await callbacks[0]();
    const prompt = mockTrigger.mock.calls[0][4] as string;
    expect(prompt).toContain('bad_date_parse');
    expect(prompt).toContain('The source shows Sunday at ForeFront Field.');
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
    correctionCleanup('pending_fix');
    await callbacks[0]();

    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('SET status=?, sent_for_correction=0'),
      ['pending', EVENT.id, 'pending_fix'],
    );
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'DELETE FROM needs_fix WHERE raw_event_id=?',
      [EVENT.id],
    );
  });

  it('returns a rejected original to the rejected archive when correction fails', async () => {
    const rejectedEvent = { ...EVENT, status: 'rejected' };
    successfulClaim(false, rejectedEvent);
    mockTrigger.mockResolvedValueOnce({ run_id: 44, inserted: 0, events: [] });
    db.default.query.mockResolvedValue([{ affectedRows: 1 }]);
    db.default.query.mockResolvedValueOnce([[]]);

    await POST(request(), context);
    correctionCleanup('rejected');
    await callbacks[0]();

    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('SET status=?, sent_for_correction=0'),
      ['rejected', EVENT.id, 'rejected'],
    );
  });

  it('does not let a stale failure callback clear a newer correction request', async () => {
    successfulClaim(false);

    await POST(request(), context);
    db.default.query.mockReset().mockResolvedValueOnce([[]]).mockResolvedValue([{ affectedRows: 1 }]);
    correctionCleanup('pending_fix', true);

    await callbacks[0]();

    expect(db.mockConn.query.mock.calls.some(
      ([sql]: [string]) => sql.includes('DELETE FROM needs_fix'),
    )).toBe(false);
    expect(db.default.query.mock.calls.some(
      ([sql]: [string]) => sql.includes('INSERT INTO notifications'),
    )).toBe(false);
  });

  it('recovers an orphaned pending correction even when its needs_fix row is missing', async () => {
    const orphaned = { ...EVENT, status: 'pending_fix', sent_for_correction: 1 };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[orphaned]])
      .mockResolvedValueOnce([[{ id: 1, email: ADMIN.email }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 44 }])
      .mockResolvedValueOnce([[{ id: 55 }]]);

    const response = await POST(request(), context);

    expect(response.status).toBe(202);
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining("re.status='pending_fix'"),
      [EVENT.id],
    );
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM needs_fix'),
      [EVENT.id, EVENT.source_id, EVENT.id],
    );
  });

  it('does not recover an event while its correction run is active', async () => {
    const correcting = { ...EVENT, status: 'pending_fix', sent_for_correction: 1 };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[correcting]])
      .mockResolvedValueOnce([[{ id: 1, email: ADMIN.email }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(db.default.getConnection).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('releases a claimed run when the database connection cannot be acquired', async () => {
    successfulClaim(false);
    db.default.getConnection.mockRejectedValueOnce(new Error('pool exhausted'));

    const response = await POST(request(), context);

    expect(response.status).toBe(500);
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining("status='failed'"),
      [expect.stringContaining('pool exhausted'), 44],
    );
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
