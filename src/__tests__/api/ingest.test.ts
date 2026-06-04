import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/[slug]/route';
import { mergePosterImages } from '@/lib/mergePosters';

jest.mock('@/lib/email', () => ({
  sendReviewNotification: jest.fn(),
}));

jest.mock('@/lib/mergePosters', () => ({
  mergePosterImages: jest.fn(),
}));

const db = require('@/lib/db');
const mockMergePosterImages = mergePosterImages as jest.Mock;

const SOURCE = {
  id: 1,
  name: 'Apollo Theatre',
  slug: 'apollo',
  active: 1,
  calendar_source_name: 'Apollo Theatre Oberlin',
};

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function makeReq(body: any) {
  return new NextRequest('http://localhost/api/ingest/apollo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'test-ingest-secret' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.INGEST_SECRET = 'test-ingest-secret';
  db.default.query.mockReset();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockMergePosterImages.mockReset();
});

describe('POST /api/ingest/:slug', () => {
  it('falls back to the first poster URL when merging poster images returns null', async () => {
    mockMergePosterImages.mockResolvedValue(null);
    db.default.query
      .mockResolvedValueOnce([[SOURCE]])
      .mockResolvedValueOnce([{ insertId: 99 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ pending: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
    db.mockConn.query
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const posterUrl = 'https://cdn.example.test/poster.jpg';
    const res = await POST(
      makeReq({
        count: 1,
        events: [{
          eventType: 'an',
          title: 'Apollo announcement',
          description: 'An announcement with a poster.',
          poster_urls: [posterUrl],
        }],
      }),
      ctx('apollo')
    );

    expect(res.status).toBe(200);
    expect(mockMergePosterImages).toHaveBeenCalledWith([posterUrl]);
    const insertCall = db.mockConn.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO raw_events')
    );
    expect(insertCall[1][22]).toBe(posterUrl);
  });
});
