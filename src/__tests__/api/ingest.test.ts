import { NextRequest } from 'next/server';
import { POST as ingestPost } from '@/app/api/ingest/[slug]/route';
import { mergePosterImages } from '@/lib/mergePosters';

jest.mock('@/lib/email', () => ({
  sendReviewNotification: jest.fn(),
}));

jest.mock('@/lib/mergePosters', () => ({
  mergePosterImages: jest.fn(),
}));

const db = require('@/lib/db');
const mockMergePosterImages = mergePosterImages as jest.MockedFunction<typeof mergePosterImages>;

const SOURCE = {
  id: 7,
  name: 'Apollo Theatre',
  slug: 'apollo-theatre',
  active: 1,
  calendar_source_name: 'Apollo Theatre',
};

function makeIngestReq(events: any[]) {
  return new NextRequest('http://localhost/api/ingest/apollo-theatre', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-secret': 'test-ingest-secret',
    },
    body: JSON.stringify({ events }),
  });
}

function slugCtx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INGEST_SECRET = 'test-ingest-secret';
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
});

describe('POST /api/ingest/[slug]', () => {
  it('continues ingesting the batch when poster merging fails for one event', async () => {
    mockMergePosterImages.mockRejectedValueOnce(new Error('Input buffer contains unsupported image format'));

    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ insertId: 123 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ pending: 2 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);

    db.mockConn.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 501 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 502 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await ingestPost(
      makeIngestReq([
        {
          eventType: 'an',
          title: 'Apollo marquee update',
          description: 'New films announced for the weekend.',
          image_cdn_url: 'https://apollotheatre.org/fallback.jpg',
          poster_urls: ['https://apollotheatre.org/bad-poster.webp'],
          calendarSourceUrl: 'https://apollotheatre.org/events/marquee-update',
        },
        {
          eventType: 'ot',
          title: 'Classic Film Night',
          description: 'A classic film screening at the Apollo.',
          calendarSourceUrl: 'https://apollotheatre.org/events/classic-film-night',
        },
      ]),
      slugCtx('apollo-theatre')
    );

    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, run_id: 123, inserted: 2 });
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
    expect(db.mockConn.rollback).not.toHaveBeenCalled();

    const insertCalls = db.mockConn.query.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO raw_events')
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1][22]).toBe('https://apollotheatre.org/fallback.jpg');
  });
});
