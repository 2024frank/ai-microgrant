import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/[slug]/route';
import { createFixIngestToken } from '@/lib/fixToken';

const db = require('@/lib/db');

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function makeReq(headers: Record<string, string>, body: any) {
  return new NextRequest('http://localhost/api/ingest/fixed-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const fixedEvent = {
  fixedFromEventId: '42',
  fixSummary: 'Added the missing phone number.',
  title: 'Corrected Event',
  description: 'Corrected description',
  eventType: 'ot',
  sponsors: [],
  postTypeId: [],
  sessions: [],
  locationType: 'ne',
};

beforeEach(() => {
  process.env.INGEST_SECRET = 'global-ingest-secret';
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
});

describe('POST /api/ingest/fixed-events correction auth', () => {
  it('rejects corrected fixed-events payloads authenticated only with the global ingest secret', async () => {
    const res = await POST(
      makeReq({ 'x-ingest-secret': 'global-ingest-secret' }, { events: [fixedEvent], count: 1 }),
      ctx('fixed-events')
    );

    expect(res.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('accepts a scoped fix token and cleans up only that correction request', async () => {
    const token = createFixIngestToken('fixed-events', 42);
    db.default.query
      .mockResolvedValueOnce([[{ id: 6, name: 'Fixed Events', slug: 'fixed-events', calendar_source_name: 'Fixed Events' }]])
      .mockResolvedValueOnce([{ insertId: 77 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    db.mockConn.query
      .mockResolvedValueOnce([[{ raw_event_id: 42, sent_by_user_id: 9, sent_by_email: 'reviewer@oberlin.edu', correction_notes: 'Missing phone' }]])
      .mockResolvedValueOnce([{ insertId: 100 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await POST(
      makeReq({ 'x-fix-token': token }, { events: [fixedEvent], count: 1 }),
      ctx('fixed-events')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.inserted).toBe(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'DELETE FROM raw_events WHERE id = ? AND status = ?',
      [42, 'pending_fix']
    );
  });
});
