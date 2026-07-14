import { NextRequest } from 'next/server';
import { DELETE, PATCH } from '@/app/api/sources/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const ADMIN = {
  id: 1,
  email: 'admin@oberlin.edu',
  role: 'admin',
  full_name: 'Admin',
  active: 1,
  firebase_uid: 'uid-admin',
};

function context(id = '4') {
  return { params: Promise.resolve({ id }) };
}

function request(body: unknown, method = 'PATCH') {
  return new NextRequest('http://localhost/api/sources/4', {
    method,
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('PATCH /api/sources/:id', () => {
  it('rejects invalid schedules before updating the database', async () => {
    db.default.query.mockResolvedValueOnce([[ADMIN]]);

    const response = await PATCH(request({ schedule_cron: '61 * * * *' }), context());

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('minute must be between 0 and 59');
    expect(db.default.query).toHaveBeenCalledTimes(1);
  });

  it('normalizes and saves a valid five-field schedule', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[
        { id: 4, name: 'Apollo', schedule_cron: '15 7 * * 1-5', active: 1 },
      ]]);

    const response = await PATCH(
      request({ schedule_cron: '  15   7  *  *  1-5  ' }),
      context(),
    );

    expect(response.status).toBe(200);
    const updateCall = db.default.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE sources SET schedule_cron = ?');
    expect(updateCall[1]).toEqual(['15 7 * * 1-5', '4']);
  });
});

describe('DELETE /api/sources/:id', () => {
  it('refuses to cascade-delete event and run history', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        { id: 4, event_count: 12, run_count: 3 },
      ]]);

    const response = await DELETE(request({}, 'DELETE'), context());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      can_disable: true,
      dependencies: { events: 12, runs: 3 },
    });
    expect(db.default.query.mock.calls.some(
      ([sql]: [string]) => sql.startsWith('DELETE FROM agent_runs'),
    )).toBe(false);
    expect(db.default.query.mock.calls.some(
      ([sql]: [string]) => sql.startsWith('UPDATE raw_events'),
    )).toBe(false);
  });

  it('deletes an unused source after removing its assignments', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        { id: 4, event_count: 0, run_count: 0 },
      ]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const response = await DELETE(request({}, 'DELETE'), context());

    expect(response.status).toBe(200);
    expect(db.default.query).toHaveBeenCalledWith(
      'DELETE FROM sources WHERE id = ?',
      ['4'],
    );
  });
});
