const mockMergePosterImages = jest.fn();

jest.mock('@/lib/mergePosters', () => ({
  mergePosterImages: (...args: any[]) => mockMergePosterImages(...args),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/[slug]/route';

const db = require('@/lib/db');

const SOURCE = {
  id: 6,
  name: 'Fixed Events',
  slug: 'fixed-events',
  active: 1,
  calendar_source_name: 'Fixed Events',
};

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function makeReq(body: any) {
  return new NextRequest('http://localhost/api/ingest/fixed-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'test-secret' },
    body: JSON.stringify(body),
  });
}

function event(overrides: Record<string, any> = {}) {
  return {
    eventType: 'an',
    title: 'Apollo Announcement',
    description: 'A community announcement.',
    sponsors: ['Apollo Theatre'],
    postTypeId: [8],
    sessions: [{ startTime: 1748476800, endTime: 1748484000 }],
    locationType: 'ph',
    display: 'all',
    calendarSourceUrl: 'https://example.com/poster',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.INGEST_SECRET = 'test-secret';
  db.default.query.mockReset();
  db.default.getConnection.mockClear();
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  mockMergePosterImages.mockReset();

  db.default.query
    .mockResolvedValueOnce([[SOURCE]])
    .mockResolvedValueOnce([{ insertId: 77 }])
    .mockResolvedValue([{ affectedRows: 1 }]);
});

describe('POST /api/ingest/:slug poster image handling', () => {
  it('falls back when merged poster data would exceed the image_cdn_url TEXT column', async () => {
    const fallbackUrl = 'https://cdn.example.com/poster.jpg';
    mockMergePosterImages.mockResolvedValue(`data:image/jpeg;base64,${'a'.repeat(70_000)}`);
    db.mockConn.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 123 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await POST(
      makeReq({ events: [event({ image_cdn_url: fallbackUrl, poster_urls: ['https://example.com/a.jpg'] })] }),
      ctx('fixed-events')
    );

    expect(res.status).toBe(200);
    const insertCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO raw_events')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][22]).toBe(fallbackUrl);
  });

  it('stores merged poster data when it fits in the image_cdn_url column', async () => {
    const mergedImage = `data:image/jpeg;base64,${'a'.repeat(1_000)}`;
    mockMergePosterImages.mockResolvedValue(mergedImage);
    db.mockConn.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 124 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await POST(
      makeReq({ events: [event({ image_cdn_url: 'https://cdn.example.com/poster.jpg', poster_urls: ['https://example.com/a.jpg'] })] }),
      ctx('fixed-events')
    );

    expect(res.status).toBe(200);
    const insertCall = db.mockConn.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO raw_events')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][22]).toBe(mergedImage);
  });
});
