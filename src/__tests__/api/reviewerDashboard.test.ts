import { NextRequest } from 'next/server';
import { GET } from '@/app/api/reviewer/dashboard/route';
import { adminAuth } from '@/lib/firebase-admin';

const db         = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN    = { id: 1, email: 'admin@oberlin.edu', role: 'admin',    full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const REVIEWER = {
  id: 2,
  email: 'rev@oberlin.edu',
  role: 'reviewer',
  full_name: 'Rev',
  active: 1,
  firebase_uid: 'uid-rev',
  can_review_all_sources: 0,
};

function makeReq() {
  return new NextRequest('http://localhost/api/reviewer/dashboard', {
    headers: { Authorization: 'Bearer valid' },
  });
}

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
});

describe('GET /api/reviewer/dashboard', () => {
  it('returns dashboard data for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])                                    // getAuthUser
      .mockResolvedValueOnce([[{ pending: 5 }]])                              // pending count (Promise.all #1)
      .mockResolvedValueOnce([[{ total_reviewed: 20, total_approved: 15, total_rejected: 5, avg_time_sec: 42, approved_today: 3, rejected_today: 1 }]]) // personalStats (#2)
      .mockResolvedValueOnce([[{ corrections_approved: 2 }]])                 // corrections_approved (#3)
      .mockResolvedValueOnce([[{ action: 'approved', title: 'Jazz Night', source_name: 'Apollo', created_at: new Date() }]]) // recentActivity (#4)
      .mockResolvedValueOnce([[{ id: 1, name: 'Apollo Theatre', slug: 'apollo', pending_count: 5 }]])  // assignedSources (#5)
      .mockResolvedValueOnce([[{ title: 'Old Event', created_at: new Date(), source_name: 'Apollo' }]]); // oldestPending (#6)

    const res  = await GET(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.pending).toBe(5);
    expect(data.personal_stats.total_approved).toBe(15);
    expect(data.recent_activity).toHaveLength(1);
    expect(data.assigned_sources).toHaveLength(1);
    expect(data.oldest_pending.title).toBe('Old Event');

    const personalStatsQuery = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('COUNT(*) AS total_reviewed'),
    );
    const correctionsQuery = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('corrections_approved'),
    );
    expect(personalStatsQuery[0]).toContain("SUM(action = 'approved')");
    expect(personalStatsQuery[0]).not.toContain('communityhub_moderation_status');
    expect(correctionsQuery[0]).toContain('COUNT(DISTINCT fixed.id)');
    expect(correctionsQuery[0]).toContain("fixed.communityhub_moderation_status = 'approved'");

    const pendingQuery = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('COUNT(*) AS pending'),
    );
    const sourcesQuery = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('SUM(re.status'),
    );
    const oldestQuery = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('ORDER BY re.created_at ASC LIMIT 1'),
    );
    for (const call of [pendingQuery, sourcesQuery, oldestQuery]) {
      expect(call).toBeDefined();
      expect(call[0]).toContain('reviewer_sources');
      expect(call[1]).toEqual([REVIEWER.id]);
    }
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns dashboard data for admin (no source filter)', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[{ pending: 12 }]])
      .mockResolvedValueOnce([[{ total_reviewed: 0, total_approved: 0, total_rejected: 0, avg_time_sec: null, approved_today: 0, rejected_today: 0 }]])
      .mockResolvedValueOnce([[{ corrections_approved: 0 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[null]]);

    const res  = await GET(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.pending).toBe(12);
    // Admin queue summaries and source breakdown remain global.
    const aggregateQueries = db.default.query.mock.calls.filter(
      ([sql]: [string]) =>
        sql.includes('COUNT(*) AS pending')
        || sql.includes('SUM(re.status')
        || sql.includes('ORDER BY re.created_at ASC LIMIT 1'),
    );
    expect(aggregateQueries).toHaveLength(3);
    for (const [sql, params] of aggregateQueries) {
      expect(sql).not.toContain('reviewer_sources');
      expect(params).toEqual([]);
    }
  });

  it('returns 401 without token', async () => {
    mockVerify.mockRejectedValueOnce(new Error('invalid'));
    const res = await GET(new NextRequest('http://localhost/api/reviewer/dashboard', {}));
    expect(res.status).toBe(401);
  });

  it('returns zero pending when queue is empty', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query
      .mockResolvedValueOnce([[REVIEWER]])
      .mockResolvedValueOnce([[{ pending: 0 }]])
      .mockResolvedValueOnce([[{ total_reviewed: 10, total_approved: 10, total_rejected: 0, avg_time_sec: 30, approved_today: 0, rejected_today: 0 }]])
      .mockResolvedValueOnce([[{ corrections_approved: 0 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[undefined]]);

    const data = await (await GET(makeReq())).json();
    expect(data.pending).toBe(0);
    expect(data.oldest_pending).toBeNull();
  });
});
