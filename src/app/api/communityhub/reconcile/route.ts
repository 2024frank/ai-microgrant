import { NextRequest } from 'next/server';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { reconcileCommunityHub } from '@/lib/communityHubReconciliation';

export const maxDuration = 300;

async function run(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const requestedLimit = Number.parseInt(req.nextUrl.searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
  const force = req.nextUrl.searchParams.get('force') === '1';
  try {
    const result = await reconcileCommunityHub({ limit, force });
    const failed = result.failed > 0;
    return Response.json({ ok: !failed, ...result }, { status: failed ? 502 : 200 });
  } catch (error) {
    console.error('[communityhub reconcile] failed:', error);
    return Response.json({ error: 'CommunityHub reconciliation failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
