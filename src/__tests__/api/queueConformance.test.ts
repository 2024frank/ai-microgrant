import { NextRequest } from 'next/server';
import { POST } from '@/app/api/agent/queue-conformance/route';

jest.mock('@/lib/safeRemoteImage', () => ({
  loadImageAsJpeg: jest.fn().mockResolvedValue(Buffer.from('poster-bytes')),
}));
jest.mock('@/lib/adminContact', () => ({
  getAdminContact: jest.fn().mockResolvedValue('admin@oberlin.edu'),
}));
jest.mock('@/lib/sourcePageImage', () => ({
  discoverSourcePageImage: jest.fn().mockResolvedValue(null),
}));

const db = require('@/lib/db');
const { loadImageAsJpeg } = jest.requireMock('@/lib/safeRemoteImage');
const { discoverSourcePageImage } = jest.requireMock('@/lib/sourcePageImage');

function makeReq(secret = 'test-cron-secret') {
  return new NextRequest('http://localhost/api/agent/queue-conformance', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    source_id: 3,
    source_slug: 'apollo-theater',
    event_type: 'ot',
    title: 'Community Jazz Night',
    description: 'An evening of live community jazz in downtown Oberlin.',
    extended_description: null,
    sponsors: JSON.stringify(['Oberlin Community Arts']),
    post_type_ids: JSON.stringify([8]),
    sessions: JSON.stringify([{ startTime: 4_102_444_800, endTime: 4_102_448_400 }]),
    location_type: 'ne',
    location: null,
    display: 'all',
    screen_ids: '[]',
    buttons: '[]',
    website: null,
    image_cdn_url: null,
    image_data: null,
    email: 'calendar@oberlin.edu',
    ...overrides,
  };
}

function mockQueue(rows: Record<string, unknown>[]) {
  db.default.query.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes("re.status='pending'")) {
      return Promise.resolve([rows]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  db.mockConn.query.mockImplementation((sql: string, params: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
      const id = Array.isArray(params) ? params[0] : undefined;
      const row = rows.find(candidate => candidate.id === id);
      return Promise.resolve([row ? [row] : []]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  db.default.query.mockReset().mockResolvedValue([[]]);
  db.default.getConnection.mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset();
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  (loadImageAsJpeg as jest.Mock).mockClear()
    .mockResolvedValue(Buffer.from('poster-bytes'));
  (discoverSourcePageImage as jest.Mock).mockClear().mockResolvedValue(null);
});

describe('POST /api/agent/queue-conformance', () => {
  it('rejects requests without the cron secret', async () => {
    const response = await POST(makeReq('wrong'));
    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('corrects an old-format queued event in place and leaves it for review', async () => {
    mockQueue([pendingRow({
      description: 'A hands-on pottery class. Register now at https://studio.example.org/classes to reserve a wheel.',
      website: 'https://studio.example.org',
    })]);

    const data = await (await POST(makeReq())).json();

    expect(data.ok).toBe(true);
    expect(data.corrected).toBe(1);
    const update = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE raw_events SET'),
    );
    expect(update![0]).toContain('description=?');
    expect(update![0]).toContain('dedup_key=?');
    expect(String(update![1][0])).toMatch(/Registration required\.$/);
    const auditInsert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('field_edit_log'),
    );
    expect(auditInsert).toBeDefined();
    // System corrections carry a NULL reviewer id.
    expect(auditInsert![0]).toContain('NULL');
  });

  it('materializes a fetchable remote poster into stored bytes', async () => {
    mockQueue([pendingRow({ image_cdn_url: 'https://images.example.org/poster.jpg' })]);

    const data = await (await POST(makeReq())).json();

    expect(data.images_materialized).toBe(1);
    expect(loadImageAsJpeg).toHaveBeenCalledWith('https://images.example.org/poster.jpg');
    const update = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE raw_events SET'),
    );
    expect(update![0]).toContain('image_data=?');
    expect(String(update![1][0])).toBe(
      `data:image/jpeg;base64,${Buffer.from('poster-bytes').toString('base64')}`,
    );
  });

  it('discovers a missing poster from the source page share metadata', async () => {
    (discoverSourcePageImage as jest.Mock).mockResolvedValueOnce(
      'https://cdn.example.org/storytime.jpg',
    );
    mockQueue([pendingRow({
      image_cdn_url: null,
      image_data: null,
      calendar_source_url: 'https://library.example.org/event/storytime',
    })]);

    const data = await (await POST(makeReq())).json();

    expect(data.items[0].image_action).toBe('discovered');
    expect(discoverSourcePageImage).toHaveBeenCalledWith('https://library.example.org/event/storytime');
    expect(loadImageAsJpeg).toHaveBeenCalledWith('https://cdn.example.org/storytime.jpg');
    const update = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE raw_events SET'),
    );
    // The discovered URL is stored for provenance and the bytes for serving.
    expect(update![0]).toContain('image_cdn_url=?');
    expect(update![0]).toContain('image_data=?');
  });

  it('records a no-source-image outcome and timestamps the attempt', async () => {
    mockQueue([pendingRow({
      image_cdn_url: null,
      image_data: null,
      calendar_source_url: 'https://library.example.org/event/storytime',
    })]);

    const data = await (await POST(makeReq())).json();

    expect(data.items[0].image_action).toBe('no_source_image');
    expect(data.ok).toBe(true);
    expect(loadImageAsJpeg).not.toHaveBeenCalled();
    const update = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('image_discovery_at=NOW()'),
    );
    expect(update).toBeDefined();
  });

  it('does not retry discovery for a recently attempted event', async () => {
    mockQueue([pendingRow({
      image_cdn_url: null,
      image_data: null,
      calendar_source_url: 'https://library.example.org/event/storytime',
      image_discovery_at: new Date().toISOString(),
    })]);

    const data = await (await POST(makeReq())).json();

    expect(data.items[0].image_action).toBeUndefined();
    expect(discoverSourcePageImage).not.toHaveBeenCalled();
  });

  it('removes a permanently unfetchable poster and flags a transient failure', async () => {
    (loadImageAsJpeg as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error('not an image'), { code: 'UNSUPPORTED_TYPE' }))
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'UPSTREAM_TIMEOUT' }));
    mockQueue([
      pendingRow({ id: 10, image_cdn_url: 'https://dead.example.org/page.html' }),
      pendingRow({ id: 11, image_cdn_url: 'https://slow.example.org/poster.jpg' }),
    ]);

    const data = await (await POST(makeReq())).json();

    expect(data.images_removed).toBe(1);
    expect(data.images_flagged).toBe(1);
    const updates = db.mockConn.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE raw_events SET'),
    );
    // The dead image is cleared; the transient one keeps its URL but the
    // stored validation issues tell the reviewer what happened.
    expect(updates.some(([sql]: [string]) => sql.includes('image_cdn_url=?'))).toBe(true);
    const flagged = updates.find(([, params]: [string, unknown[]]) =>
      String(params.at(-2)).includes('image_unfetchable'));
    expect(flagged).toBeDefined();
  });

  it('rejects a still-invalid queued event with the reason preserved', async () => {
    mockQueue([pendingRow({ post_type_ids: '[]' })]);

    const data = await (await POST(makeReq())).json();

    expect(data.rejected_missing_required).toBe(1);
    const rejection = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO rejection_log'),
    );
    expect(rejection![0]).toContain("'system'");
    expect(rejection![1]).toEqual(expect.arrayContaining([
      JSON.stringify(['missing_fields']),
      expect.stringContaining('Required fields are missing.'),
    ]));
  });

  it('rejects a noun-only opportunity announcement as format-nonconforming', async () => {
    mockQueue([pendingRow({
      event_type: 'an',
      title: 'Summer Symphony',
      description: 'Registration is required for the summer symphony day camp.',
      buttons: JSON.stringify([{ title: 'Register', link: 'https://symphony.example.org/camp' }]),
      website: 'https://symphony.example.org/camp',
    })]);

    const data = await (await POST(makeReq())).json();

    expect(data.rejected_format).toBe(1);
    const rejection = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO rejection_log'),
    );
    expect(rejection![1]).toEqual(expect.arrayContaining([
      JSON.stringify(['format_nonconforming']),
      expect.stringContaining('does not state the action'),
    ]));
  });

  it('skips an event whose state changed before the row lock', async () => {
    mockQueue([pendingRow()]);
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const data = await (await POST(makeReq())).json();

    expect(data.checked).toBe(1);
    expect(data.items[0].decision).toBe('skipped_state_changed');
    expect(db.mockConn.rollback).toHaveBeenCalled();
  });
});
