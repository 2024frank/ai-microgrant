import { NextRequest } from 'next/server';
import { GET } from '@/app/api/communityhub/reconcile/route';
import { reconcileCommunityHub } from '@/lib/communityHubReconciliation';

jest.mock('@/lib/communityHubReconciliation', () => ({
  reconcileCommunityHub: jest.fn(),
}));

const mockReconcile = reconcileCommunityHub as jest.Mock;

function request() {
  return new NextRequest('http://localhost/api/communityhub/reconcile', {
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
}

const SUMMARY = {
  checked: 1,
  approved: 0,
  pending: 1,
  rejected: 0,
  missing: 0,
  unknown: 0,
  repaired: 0,
  submissions_recovered: 0,
  prepared_released: 0,
  unchecked: 0,
  updates_checked: 0,
  updates_succeeded: 0,
  updates_ambiguous: 0,
  updates_failed: 0,
  failed: 0,
  skipped_locked: false,
  results: [],
  update_results: [],
};

describe('GET /api/communityhub/reconcile', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    mockReconcile.mockReset().mockResolvedValue(SUMMARY);
  });

  it('returns 200 only when reconciliation has no semantic failures', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, failed: 0 });
  });

  it('returns a non-2xx status when an item could not be reconciled', async () => {
    mockReconcile.mockResolvedValueOnce({ ...SUMMARY, failed: 1, unknown: 1 });

    const response = await GET(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, failed: 1 });
  });
});
