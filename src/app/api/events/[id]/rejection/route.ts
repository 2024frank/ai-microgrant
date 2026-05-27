import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, reviewerSourceScope, unauthorized } from '@/lib/auth';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const { clause: scopeClause, params: scopeParams } = reviewerSourceScope(user, 're');

  const [[rejection]] = await pool.query(
    `SELECT rl.reason_codes, rl.reviewer_note, rl.created_at,
            u.full_name AS reviewer_name
     FROM rejection_log rl
     JOIN raw_events re ON re.id = rl.raw_event_id
     LEFT JOIN users u ON rl.reviewer_id = u.id
     WHERE rl.raw_event_id = ? ${scopeClause}
     ORDER BY rl.created_at DESC LIMIT 1`,
    [id, ...scopeParams]
  ) as any;

  if (!rejection) return Response.json(null, { status: 404 });
  return Response.json(rejection);
}
