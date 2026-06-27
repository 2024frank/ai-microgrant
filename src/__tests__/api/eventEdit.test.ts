import { NextRequest } from 'next/server';
import { POST } from '@/app/api/events/[id]/edit/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
function ctx(id: string) { return { params: Promise.resolve({ id }) }; }

const ADMIN = { id: 1, email: 'admin@oberlin.edu', role: 'admin', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, email: 'rev@oberlin.edu', role: 'reviewer', full_name: 'Rev', active: 1, firebase_uid: 'uid-rev' };
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
  db.mockConn.query.mockReset();
  db.mockConn.query.mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit           = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback         = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release          = jest.fn();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('POST /api/events/:id/edit', () => {
  it('saves field edits and logs them for agent learning', async () => {
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
    expect(data.agent_id).toBe('agt_test_123');
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

  it('logs teaching note to rejection_log when note provided', async () => {
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

  it('returns 403 when reviewer tries to edit an out-of-scope event', async () => {
    mockVerify.mockResolvedValueOnce({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[{ ...MOCK_EVENT, source_id: 2 }]])
      .mockResolvedValueOnce([[{ user_count: 1, assignment_count: 1, matching_count: 0 }]]);

    const res = await POST(
      makeReq('10', { edits: { title: 'Out of scope edit' } }),
      ctx('10')
    );

    expect(res.status).toBe(403);
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });
});
