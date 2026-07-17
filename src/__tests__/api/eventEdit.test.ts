import { NextRequest } from 'next/server';
import { POST } from '@/app/api/events/[id]/edit/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
function ctx(id: string) { return { params: Promise.resolve({ id }) }; }

const ADMIN = { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'reviewer@oberlin.edu', role: 'reviewer', full_name: 'Reviewer', active: 1, firebase_uid: 'uid-reviewer' };
const MOCK_EVENT = {
  id: 10, title: 'Original Title', status: 'pending', event_type: 'ot',
  description: 'Original desc', sessions: '[]', location_type: 'ph2',
  location: '123 Main St', sponsors: '["Oberlin College"]',
  post_type_ids: '[6]', source_id: 1, agent_id: 'agt_test_123',
  screen_ids: '[]', buttons: '[]',
};

function makeReq(id: string, body: any) {
  return new NextRequest(`http://localhost/api/events/${id}/edit`, {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  db.default.getConnection.mockClear();
  db.mockConn.query.mockReset();
  db.mockConn.query.mockImplementation((sql: unknown) => {
    if (typeof sql === 'string' && sql.includes('SELECT id FROM raw_events')) {
      return Promise.resolve([[{ id: MOCK_EVENT.id }]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('POST /api/events/:id/edit', () => {
  it('saves field edits and records them as bounded feedback evidence', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[MOCK_EVENT]])
      .mockResolvedValueOnce([[{ id: 1 }]])        // db user lookup
      .mockResolvedValueOnce([[{ ...MOCK_EVENT, title: 'New Title' }]]); // updated event

    const res  = await POST(
      makeReq('10', { edits: { title: 'New Title', description: 'Updated desc' } }),
      ctx('10')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.changed_fields).toContain('title');
    expect(data.changed_fields).toContain('description');
    expect(data.ready_to_publish).toBe(false);
    expect(data.validation_errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sessions', code: 'required' }),
    ]));
    const update = db.mockConn.query.mock.calls.find((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE raw_events SET')
    );
    expect(update?.[0]).toContain('validation_errors = ?');
  });

  it('returns empty changed_fields when nothing actually changed', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[MOCK_EVENT]])
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[MOCK_EVENT]]);

    const res  = await POST(
      makeReq('10', { edits: { title: 'Original Title' } }),  // same value
      ctx('10')
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.changed_fields).toHaveLength(0);
  });

  it('persists event type edits instead of silently ignoring them', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[MOCK_EVENT]])
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[{ ...MOCK_EVENT, event_type: 'an' }]]);

    const res = await POST(makeReq('10', { edits: { event_type: 'an' } }), ctx('10'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.changed_fields).toContain('event_type');
    const update = db.mockConn.query.mock.calls.find((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE raw_events SET')
    );
    expect(update?.[1]).toContain('an');
  });

  it('rejects legacy category codes as new event type edits', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(makeReq('10', { edits: { event_type: 'ev' } }), ctx('10'));
    expect(res.status).toBe(400);
  });

  it('rejects event type values outside the database contract', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);
    const res = await POST(makeReq('10', { edits: { event_type: 'made-up' } }), ctx('10'));
    expect(res.status).toBe(400);
  });

  it('logs a reviewer note to rejection_log when provided', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[MOCK_EVENT]])
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[MOCK_EVENT]]);

    await POST(
      makeReq('10', { edits: { title: 'Fixed Title' }, note: 'Agent extracted wrong title' }),
      ctx('10')
    );

    // Should have inserted into rejection_log (conn.query call with 'field_correction')
    const connCalls = db.mockConn.query.mock.calls;
    const rejectionInsert = connCalls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('rejection_log')
    );
    expect(rejectionInsert).toBeTruthy();
    expect(rejectionInsert[1]).toContain(JSON.stringify(['field_correction']));
  });

  it('replaces a stale embedded poster with an external URL atomically', async () => {
    const eventWithEmbedded = {
      ...MOCK_EVENT,
      image_cdn_url: null,
      image_data: 'data:image/jpeg;base64,b2xk',
    };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[eventWithEmbedded]])
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[
        { ...eventWithEmbedded, image_cdn_url: 'https://images.example.com/new.jpg', image_data: null },
      ]]);

    const response = await POST(makeReq('10', {
      edits: { image_cdn_url: 'https://images.example.com/new.jpg' },
    }), ctx('10'));
    const body = await response.json();

    expect(response.status).toBe(200);
    const update = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('image_cdn_url = ?') && sql.includes('image_data = ?'),
    );
    expect(update?.[1]).toEqual(expect.arrayContaining([
      'https://images.example.com/new.jpg',
      null,
    ]));
    expect(body.event).not.toHaveProperty('image_data');
    expect(body.event.has_image_data).toBe(false);
  });

  it('redacts embedded poster bytes from permanent correction snapshots', async () => {
    const eventWithEmbedded = {
      ...MOCK_EVENT,
      image_data: `data:image/png;base64,${'A'.repeat(100_000)}`,
    };
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[eventWithEmbedded]])
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[eventWithEmbedded]]);

    await POST(makeReq('10', { edits: { title: 'Safer title' } }), ctx('10'));

    const rejectionInsert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO rejection_log'),
    );
    const snapshot = JSON.parse(rejectionInsert[1][6]);
    expect(snapshot).not.toHaveProperty('image_data');
    expect(snapshot.image_data_redacted).toContain('embedded image redacted');
    expect(rejectionInsert[1][6].length).toBeLessThan(5_000);
  });

  it('returns 404 when event not found', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])  // no event
      .mockResolvedValueOnce([[{ id: 1 }]]);

    const res = await POST(
      makeReq('999', { edits: { title: 'X' } }),
      ctx('999')
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    const res = await POST(
      new NextRequest('http://localhost/api/events/10/edit', { method: 'POST', body: '{}' }),
      ctx('10')
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 before editing an event outside the reviewer assignment', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-reviewer', email: 'reviewer@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[MOCK_EVENT]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const res = await POST(makeReq('10', { edits: { title: 'Not allowed' } }), ctx('10'));
    expect(res.status).toBe(403);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });
});
