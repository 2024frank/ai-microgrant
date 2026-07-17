import { NextRequest } from 'next/server';
import { POST } from '@/app/api/communityhub/content-reconcile/route';
import { getAuthUser } from '@/lib/auth';
import { reconcileCommunityHubContent } from '@/lib/communityHubContentReconciliation';

jest.mock('@/lib/auth', () => ({
  getAuthUser: jest.fn(),
  unauthorized: jest.fn(() => Response.json({ error: 'Unauthorized' }, { status: 401 })),
  forbidden: jest.fn(() => Response.json({ error: 'Forbidden' }, { status: 403 })),
}));

jest.mock('@/lib/communityHubContentReconciliation', () => ({
  reconcileCommunityHubContent: jest.fn(),
}));

const mockAuth = getAuthUser as jest.Mock;
const mockReconcile = reconcileCommunityHubContent as jest.Mock;

const RESULT = {
  mode: 'dry-run',
  inventory: {
    approved: 42,
    pending: 18,
    pages: 1,
    reported_count: 60,
    reported_unapproved_count: 19,
    sha256: 'abc',
  },
  candidate_rows: 1,
  expired_or_invalid_session_rows: 0,
  eligible_waiting_rows: 1,
  exact_matches: 0,
  probable_matches_retained: 0,
  proven_absent: 1,
  deleted: 0,
  deleted_event_ids: [],
  apply_skips: [],
  reports: [],
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/communityhub/content-reconcile', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/communityhub/content-reconcile', () => {
  beforeEach(() => {
    mockAuth.mockReset().mockResolvedValue({ role: 'admin' });
    mockReconcile.mockReset().mockResolvedValue(RESULT);
  });

  it('runs a non-mutating content dry-run for an admin', async () => {
    const response = await POST(request({ apply: false }));

    expect(response.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith({ apply: false });
    expect(await response.json()).toMatchObject({ ok: true, proven_absent: 1 });
  });

  it('requires an explicit destructive confirmation before apply mode', async () => {
    const rejected = await POST(request({ apply: true }));
    expect(rejected.status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();

    const accepted = await POST(request({
      apply: true,
      confirmation: 'DELETE_PROVEN_ABSENT',
    }));
    expect(accepted.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith({ apply: true });
  });

  it('rejects reviewers and unauthenticated callers', async () => {
    mockAuth.mockResolvedValueOnce({ role: 'reviewer' });
    expect((await POST(request({ apply: false }))).status).toBe(403);

    mockAuth.mockResolvedValueOnce(null);
    expect((await POST(request({ apply: false }))).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('rejects malformed input and hides operational errors', async () => {
    expect((await POST(request({ apply: 'yes' }))).status).toBe(400);
    mockReconcile.mockRejectedValueOnce(new Error('database credentials'));
    const response = await POST(request({ apply: false }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'CommunityHub content reconciliation failed' });
  });
});
