jest.mock('@/lib/mergePosters', () => ({
  mergePosterImages: jest.fn(),
}));

jest.mock('@/lib/email', () => ({
  sendReviewNotification: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/[slug]/route';
import { mergePosterImages } from '@/lib/mergePosters';

const db = require('@/lib/db');
const mockMergePosterImages = mergePosterImages as jest.Mock;

const SOURCE = {
  id: 6,
  name: 'Fixed Events',
  slug: 'fixed-events',
  active: 1,
  calendar_source_name: 'Fixed Events',
};

function ctx(slug = 'fixed-events') {
  return { params: Promise.resolve({ slug }) };
}

function makeReq(body: any) {
  return new NextRequest('http://localhost/api/ingest/fixed-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'test-ingest-secret' },
    body: JSON.stringify(body),
  });
}

function mockSourceAndRun() {
  db.default.query
    .mockResolvedValueOnce([[SOURCE]])
    .mockResolvedValueOnce([{ insertId: 99 }])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
}

beforeEach(() => {
  process.env.INGEST_SECRET = 'test-ingest-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockMergePosterImages.mockReset();
  mockMergePosterImages.mockResolvedValue(null);
});

describe('POST /api/ingest/:slug', () => {
  it('falls back to the first poster URL when a merged poster would exceed the DB column', async () => {
    mockSourceAndRun();
    mockMergePosterImages.mockResolvedValue(`data:image/jpeg;base64,${'a'.repeat(70_000)}`);
    db.mockConn.query
      .mockResolvedValueOnce([{ insertId: 44 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await POST(
      makeReq({
        events: [{
          title: 'Poster event',
          description: 'Has several posters',
          sessions: [],
          poster_urls: ['https://example.com/poster-one.jpg', 'https://example.com/poster-two.jpg'],
        }],
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    const insertCall = db.mockConn.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO raw_events')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][22]).toBe('https://example.com/poster-one.jpg');
  });

  it('skips stale fixed-agent callbacks when no active fix request exists', async () => {
    mockSourceAndRun();
    db.mockConn.query.mockResolvedValueOnce([[]]);

    const res = await POST(
      makeReq({
        events: [{
          fixedFromEventId: '10',
          title: 'Late fix',
          description: 'The original request already failed or completed',
          sessions: [],
        }],
      }),
      ctx()
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.inserted).toBe(0);
    expect(db.mockConn.query.mock.calls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO raw_events')
    )).toBe(false);
  });

  it('removes an unreviewed original event when an active correction is ingested', async () => {
    mockSourceAndRun();
    db.mockConn.query
      .mockResolvedValueOnce([[{ raw_event_id: 10, sent_by_user_id: null, sent_by_email: 'reviewer@oberlin.edu' }]])
      .mockResolvedValueOnce([{ insertId: 55 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await POST(
      makeReq({
        events: [{
          fixedFromEventId: '10',
          title: 'Corrected event',
          description: 'Ready for review',
          sessions: [],
        }],
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    const deleteOriginalCall = db.mockConn.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('DELETE FROM raw_events')
    );
    expect(deleteOriginalCall).toBeDefined();
    expect(deleteOriginalCall[0]).toContain("status IN ('pending','pending_fix')");
    expect(deleteOriginalCall[1]).toEqual([10]);
  });
});
