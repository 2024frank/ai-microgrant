import { NextRequest } from 'next/server';
import { POST as sendForCorrection } from '@/app/api/review/events/[id]/send-for-correction/route';
import { POST as reviewAction } from '@/app/api/review/events/[id]/action/route';
import { POST as ingest } from '@/app/api/ingest/[slug]/route';
import { adminAuth } from '@/lib/firebase-admin';
import { createFixToken } from '@/lib/fixToken';
import { triggerAgentRun } from '@/lib/agentRunner';

jest.mock('@/lib/agentRunner', () => ({
  triggerAgentRun: jest.fn().mockResolvedValue({ run_id: 900, inserted: 0, events: [] }),
}));

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockTriggerAgentRun = triggerAgentRun as jest.Mock;

const REVIEWER = {
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
  title: 'Needs Phone',
  status: 'pending',
  calendar_source_url: 'https://example.edu/events/needs-phone',
  event_type: 'ot',
  description: 'Missing contact info',
  sessions: '[]',
  sponsors: '[]',
  post_type_ids: '[]',
  buttons: '[]',
  location_type: 'ne',
  calendar_source_name: 'Example',
  ingested_post_url: 'http://localhost/events/123',
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function slugCtx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function authReq(path: string, body: any) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ingestReq(slug: string, body: any, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/ingest/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  db.default.getConnection.mockClear();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1, insertId: 900 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: REVIEWER.firebase_uid, email: REVIEWER.email });
  mockTriggerAgentRun.mockClear();
});

describe('POST /api/review/events/:id/send-for-correction', () => {
  it('forbids scoped reviewers from sending another source for correction', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]]) // getAuthUser
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ id: REVIEWER.id, email: REVIEWER.email }]])
      .mockResolvedValueOnce([[{ assignments: 1, matching_assignments: 0 }]]);

    const res = await sendForCorrection(
      authReq('/api/review/events/123/send-for-correction', { correction_notes: 'Find the phone number' }),
      ctx('123')
    );

    expect(res.status).toBe(403);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('uses the fixed-events source and sends a scoped fix token, not the global ingest secret', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]]) // getAuthUser
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[{ id: REVIEWER.id, email: REVIEWER.email }]])
      .mockResolvedValueOnce([[{ assignments: 0, matching_assignments: null }]])
      .mockResolvedValueOnce([[{ id: 42, agent_id: 'agt_fixed_events' }]]);

    const res = await sendForCorrection(
      authReq('/api/review/events/123/send-for-correction', { correction_notes: 'Find the phone number' }),
      ctx('123')
    );
    const data = await res.json();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(data.fix_run_id).toBe(900);
    const agentRunInsert = db.mockConn.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO agent_runs')
    );
    expect(agentRunInsert[1]).toEqual([42]);

    expect(mockTriggerAgentRun).toHaveBeenCalledTimes(1);
    expect(mockTriggerAgentRun.mock.calls[0][0]).toBe(42);
    const prompt = mockTriggerAgentRun.mock.calls[0][4] as string;
    expect(prompt).toContain('Header: x-fix-token:');
    expect(prompt).toContain(`"fixedFromEventId": "${EVENT.id}"`);
    expect(prompt).not.toContain(process.env.INGEST_SECRET);
  });
});

describe('POST /api/review/events/:id/action correction guard', () => {
  it('blocks approval while an event is pending an AI correction', async () => {
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]]) // getAuthUser
      .mockResolvedValueOnce([[{ ...EVENT, status: 'pending_fix' }]]);

    const res = await reviewAction(
      authReq('/api/review/events/123/action', { action: 'approve' }),
      ctx('123')
    );

    expect(res.status).toBe(409);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/fixed-events', () => {
  it('rejects fixed-event payloads that omit fixedFromEventId instead of matching by URL', async () => {
    db.default.query.mockResolvedValueOnce([[{ id: 42, slug: 'fixed-events', name: 'Fixed Events' }]]);

    const res = await ingest(
      ingestReq(
        'fixed-events',
        { events: [{ title: 'Corrected', calendarSourceUrl: EVENT.calendar_source_url }] },
        { 'x-ingest-secret': process.env.INGEST_SECRET! }
      ),
      slugCtx('fixed-events')
    );

    expect(res.status).toBe(422);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('accepts a scoped fix token and resolves only the exact pending_fix event id', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ id: 42, slug: 'fixed-events', name: 'Fixed Events' }]])
      .mockResolvedValueOnce([{ insertId: 700 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    db.mockConn.query
      .mockResolvedValueOnce([[
        {
          raw_event_id: EVENT.id,
          source_id: EVENT.source_id,
          sent_by_user_id: REVIEWER.id,
          sent_by_email: REVIEWER.email,
          correction_notes: 'Find the phone number',
          raw_status: 'pending_fix',
        },
      ]])
      .mockResolvedValueOnce([{ insertId: 555 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await ingest(
      ingestReq(
        'fixed-events',
        {
          events: [{
            fixedFromEventId: EVENT.id,
            title: 'Corrected',
            description: 'Now includes contact info',
            eventType: 'ot',
            sessions: [],
          }],
        },
        { 'x-fix-token': createFixToken(EVENT.id) }
      ),
      slugCtx('fixed-events')
    );

    expect(res.status).toBe(200);
    const sql = db.mockConn.query.mock.calls.map((call: any[]) => call[0]).join('\n');
    expect(sql).toContain('WHERE nf.raw_event_id = ?');
    expect(sql).not.toContain('calendar_source_url');
    const deleteOriginal = db.mockConn.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('DELETE FROM raw_events')
    );
    expect(deleteOriginal[1]).toEqual([EVENT.id, 'pending_fix']);
  });
});
