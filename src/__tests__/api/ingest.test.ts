import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/[slug]/route';

const db = require('@/lib/db');

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function makeReq(slug: string, body: any) {
  return new NextRequest(`http://localhost/api/ingest/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'test-secret' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.INGEST_SECRET = 'test-secret';
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
});

describe('POST /api/ingest/:slug fixed-event recovery', () => {
  it('cleans up the matched needs_fix event, not a bad fixedFromEventId', async () => {
    db.default.query
      .mockResolvedValueOnce([[{ id: 6, name: 'Fixed Events', slug: 'fixed-events', active: 1 }]])
      .mockResolvedValueOnce([{ insertId: 123 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    db.mockConn.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{
        raw_event_id: 42,
        source_id: 1,
        sent_by_user_id: 5,
        sent_by_email: 'reviewer@oberlin.edu',
        correction_notes: 'Fix the venue',
      }]])
      .mockResolvedValueOnce([{ insertId: 77 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 9 }]);

    const res = await POST(
      makeReq('fixed-events', {
        events: [{
          fixedFromEventId: '999',
          title: 'Corrected event',
          description: 'Corrected details',
          calendarSourceUrl: 'https://example.edu/events/original',
        }],
      }),
      ctx('fixed-events')
    );

    expect(res.status).toBe(200);

    const insertCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO raw_events')
    );
    expect(insertCall[1][28]).toBe(42);

    const needsFixDelete = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM needs_fix')
    );
    const rawEventDelete = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM raw_events')
    );
    expect(needsFixDelete[1]).toEqual([42]);
    expect(rawEventDelete[1]).toEqual([42, 'pending_fix']);
  });
});
