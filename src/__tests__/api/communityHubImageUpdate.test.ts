import { NextRequest } from 'next/server';

jest.mock('@/lib/communityHubInventory', () => ({
  fetchCommunityHubInventory: jest.fn(),
}));

import { POST } from '@/app/api/agent/communityhub-image-update/route';
import { fetchCommunityHubInventory } from '@/lib/communityHubInventory';

const db = require('@/lib/db');
const mockFetch = jest.fn();
const originalFetch = global.fetch;
beforeAll(() => { global.fetch = mockFetch as any; });
afterAll(() => { global.fetch = originalFetch; });

function post(id: string, name: string, sourceName = 'Oberlin Public Library') {
  return { title: name, raw: { id, name, calendarSourceName: sourceName, sponsors: [], organizations: [] } };
}

const INVENTORY = {
  posts: [
    post('3994', 'L.E.G.O.'),
    post('5000', 'Storytime'),            // short title; must fuzzy-match "Storytime at Oberlin Public Library"
    post('5048', 'Kitten Storytime'),     // must fuzzy-match "Kitten Storytime at OPL"
    post('4987', 'Oberlin Writers'),      // no image supplied
    post('7777', 'Downtown Jazz Night', 'Apollo Theatre'), // not a library post
  ],
};

function makeReq(qs = '') {
  return new NextRequest(`http://localhost/api/agent/communityhub-image-update${qs}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
}

describe('POST /api/agent/communityhub-image-update', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    (fetchCommunityHubInventory as jest.Mock).mockReset().mockResolvedValue(INVENTORY);
    db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
    mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
  });

  it('rejects without the cron secret', async () => {
    const res = await POST(new NextRequest('http://localhost/api/agent/communityhub-image-update', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('dry-runs: fuzzy-matches library posts by name, ignores non-library posts, writes nothing', async () => {
    const body = await (await POST(makeReq())).json();
    expect(body.apply).toBe(false);
    expect(body.library_posts).toBe(4); // the Apollo post is excluded
    // LEGO, Storytime, Kitten all match; Oberlin Writers has no image
    expect(body.matched).toBe(3);
    expect(body.unmatched).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    const legos = body.items.find((i: any) => i.post_id === '5000');
    expect(legos.matched_title).toBe('Storytime at Oberlin Public Library');
  });

  it('with limit=1 touches exactly one post', async () => {
    const body = await (await POST(makeReq('?limit=1'))).json();
    expect(body.items.filter((i: any) => i.status === 'matched')).toHaveLength(1);
  });

  it('apply PATCHes the existing post by id with the public image URL (no duplicate)', async () => {
    const body = await (await POST(makeReq('?apply=1&limit=1'))).json();
    expect(body.updated).toBe(1);
    const [chUrl, chInit] = mockFetch.mock.calls[0];
    expect(String(chUrl)).toBe('https://oberlin.communityhub.cloud/api/legacy/calendar/post/3994/submit');
    expect(chInit.method).toBe('PATCH');
    const sent = JSON.parse(chInit.body);
    expect(Object.keys(sent)).toEqual(['image_cdn_url']);
    expect(String(sent.image_cdn_url)).toContain('images.locable.com');
  });

  it('reports a CH failure as an error without throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422, text: async () => 'bad image' });
    const body = await (await POST(makeReq('?apply=1&limit=1'))).json();
    expect(body.ok).toBe(false);
    expect(body.errors).toBe(1);
    expect(body.items[0].ch_status).toBe(422);
  });
});
