import { NextRequest } from 'next/server';

jest.mock('@/lib/safeRemoteImage', () => ({
  loadImageAsJpeg: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
}));

import { POST } from '@/app/api/agent/communityhub-image-update/route';
import { loadImageAsJpeg } from '@/lib/safeRemoteImage';

const db = require('@/lib/db');
const mockFetch = jest.fn();
const originalFetch = global.fetch;
beforeAll(() => { global.fetch = mockFetch as any; });
afterAll(() => { global.fetch = originalFetch; });

const LIB_ROWS = [
  { id: 501, title: 'L.E.G.O.', communityhub_post_id: '3994', status: 'approved' },
  { id: 502, title: 'Music Open Mic', communityhub_post_id: '4349', status: 'submitted' },
  { id: 503, title: 'Some Unlisted Program', communityhub_post_id: '9999', status: 'approved' },
];

function makeReq(qs = '') {
  return new NextRequest(`http://localhost/api/agent/communityhub-image-update${qs}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
}

describe('POST /api/agent/communityhub-image-update', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.APP_URL = 'https://app.example.org';
    process.env.MEDIA_PROXY_SECRET = 'a-sufficiently-long-media-secret';
    db.default.query.mockReset().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM raw_events')) return Promise.resolve([LIB_ROWS]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    (loadImageAsJpeg as jest.Mock).mockClear().mockResolvedValue(Buffer.from('jpeg-bytes'));
    mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
  });

  it('rejects without the cron secret', async () => {
    const res = await POST(new NextRequest('http://localhost/api/agent/communityhub-image-update', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('dry-runs by default: matches by title, writes nothing, calls no CH', async () => {
    const body = await (await POST(makeReq())).json();
    expect(body.apply).toBe(false);
    expect(body.matched).toBe(2); // LEGO + Music Open Mic; the third has no image
    expect(body.unmatched).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(loadImageAsJpeg).not.toHaveBeenCalled();
    const write = db.default.query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE raw_events SET image_data'));
    expect(write).toBeUndefined();
  });

  it('with limit=1 touches exactly one event', async () => {
    const body = await (await POST(makeReq('?limit=1'))).json();
    expect(body.items.filter((i: any) => i.status === 'matched')).toHaveLength(1);
  });

  it('apply materializes the image and PATCHes the existing post by id (no duplicate)', async () => {
    const body = await (await POST(makeReq('?apply=1&limit=1'))).json();
    expect(body.updated).toBe(1);
    expect(loadImageAsJpeg).toHaveBeenCalledTimes(1);
    // The stored bytes are written before the CH call.
    const write = db.default.query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE raw_events SET image_data'));
    expect(write).toBeDefined();
    // The CH call is a PATCH to /post/{id}/submit, never a create POST.
    const [chUrl, chInit] = mockFetch.mock.calls[0];
    expect(String(chUrl)).toBe('https://oberlin.communityhub.cloud/api/legacy/calendar/post/3994/submit');
    expect(chInit.method).toBe('PATCH');
    const sent = JSON.parse(chInit.body);
    expect(String(sent.image_cdn_url)).toContain('/api/events/501/poster.jpg?media_token=');
    expect(Object.keys(sent)).toEqual(['image_cdn_url']); // partial update: image only
  });

  it('reports a CH failure as an error without throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422, text: async () => 'bad image' });
    const body = await (await POST(makeReq('?apply=1&limit=1'))).json();
    expect(body.ok).toBe(false);
    expect(body.errors).toBe(1);
    expect(body.items[0].ch_status).toBe(422);
  });
});
