import { NextRequest } from 'next/server';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import { isCronAuthorized } from '@/lib/cronAuth';
import { reconcileCommunityHubContent } from '@/lib/communityHubContentReconciliation';

export const maxDuration = 300;

const APPLY_CONFIRMATION = 'DELETE_PROVEN_ABSENT';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(req: NextRequest) {
  // Operators run this either as an admin or through the deployment's cron
  // secret (the operational workflows); apply mode always needs the explicit
  // confirmation below regardless of the credential used.
  if (!isCronAuthorized(req)) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Request body must be an object' }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (input.apply !== undefined && typeof input.apply !== 'boolean') {
    return Response.json({ error: 'apply must be a boolean' }, { status: 400 });
  }
  const apply = input.apply === true;
  if (apply && input.confirmation !== APPLY_CONFIRMATION) {
    return Response.json({
      error: `Apply mode requires confirmation=${APPLY_CONFIRMATION}`,
    }, { status: 400 });
  }

  try {
    const result = await reconcileCommunityHubContent({ apply });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    console.error('[communityhub content reconcile] failed:', error);
    return Response.json(
      { error: 'CommunityHub content reconciliation failed' },
      { status: 500, headers: NO_STORE },
    );
  }
}
