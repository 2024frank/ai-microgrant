import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/agent-analytics/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const ADMIN = {
  id: 1,
  role: 'admin',
  email: 'admin@oberlin.edu',
  full_name: 'Admin',
  active: 1,
  firebase_uid: 'uid-admin',
};

beforeEach(() => {
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/admin/agent-analytics', () => {
  it('counts only externally verified CommunityHub publications without edit-join duplicates', async () => {
    db.default.query
      .mockResolvedValueOnce([[ADMIN]])
      .mockResolvedValueOnce([[
        {
          id: 4,
          name: 'Calendar',
          slug: 'calendar',
          agent_id: 'agt_calendar',
          active: 1,
          total: 3,
          approved: 1,
          rejected: 1,
          pending: 1,
          edited: 1,
          clean_approved: 0,
        },
      ]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);

    const res = await GET(new NextRequest('http://localhost/api/admin/agent-analytics?days=30', {
      headers: { Authorization: 'Bearer valid' },
    }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.sources[0]).toMatchObject({ approved: 1, clean_approved: 0 });

    const aggregateQuery = db.default.query.mock.calls[1][0];
    expect(aggregateQuery).toContain('COUNT(DISTINCT CASE');
    expect(aggregateQuery).toContain(
      "re.status = 'approved' AND re.communityhub_moderation_status = 'approved'",
    );
    expect(aggregateQuery).toContain('AND fel.raw_event_id IS NULL');
  });
});
