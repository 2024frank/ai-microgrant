import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/activity/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN    = { id: 1, role: 'admin',    email: 'admin@oberlin.edu', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = { id: 2, role: 'reviewer', email: 'rev@oberlin.edu',   full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };

function makeReq() {
  return new NextRequest('http://localhost/api/admin/activity', {
    headers: { Authorization: 'Bearer valid' },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/admin/activity', () => {
  it('returns activity data for admin', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        { id: 1, action: 'approved', reviewer_name: 'Jane', event_title: 'Jazz Night', source_name: 'Apollo', created_at: new Date() },
      ]])
      .mockResolvedValueOnce([[
        { id: 1, full_name: 'Jane', total_reviewed: 15, approved: 12, rejected: 3, avg_time_sec: 38, approved_today: 2 },
      ]])
      .mockResolvedValueOnce([[
        { id: 1, status: 'completed', events_extracted: 10, source_name: 'Oberlin College', started_at: new Date() },
      ]])
      .mockResolvedValueOnce([[
        { pending: 5, approved_today: 8, rejected_today: 2, extracted_today: 15 },
      ]]);

    const res  = await GET(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recent_actions).toHaveLength(1);
    expect(data.reviewer_stats).toHaveLength(1);
    expect(data.recent_runs).toHaveLength(1);
    expect(data.today.pending).toBe(5);
    expect(data.today.approved_today).toBe(8);

    const reviewerQuery = db.default.query.mock.calls[2][0];
    const systemTodayQuery = db.default.query.mock.calls[4][0];
    expect(reviewerQuery).toContain("rs.action = 'approved'");
    expect(reviewerQuery).not.toContain('communityhub_moderation_status');
    expect(systemTodayQuery).toContain("communityhub_moderation_status = 'approved'");
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[REVIEWER]]);
    expect((await GET(makeReq())).status).toBe(403);
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    expect((await GET(new NextRequest('http://localhost/api/admin/activity', {}))).status).toBe(401);
  });

  it('reviewer_stats sorted by total_reviewed descending', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[
        { id: 1, full_name: 'Alice', total_reviewed: 30, approved: 25, rejected: 5, avg_time_sec: 35, approved_today: 3 },
        { id: 2, full_name: 'Bob',   total_reviewed: 10, approved: 8,  rejected: 2, avg_time_sec: 45, approved_today: 1 },
      ]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ pending: 0, approved_today: 0, rejected_today: 0, extracted_today: 0 }]]);

    const data = await (await GET(makeReq())).json();
    expect(data.reviewer_stats[0].full_name).toBe('Alice');
    expect(data.reviewer_stats[0].total_reviewed).toBe(30);
  });
});
