import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import { canAccessSource } from '@/lib/reviewerAccess';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;

  const [[rejection]] = await pool.query(
    `SELECT rl.reason_codes, rl.reviewer_note, rl.created_at,
            u.full_name AS reviewer_name, re.source_id
     FROM rejection_log rl
     JOIN raw_events re ON re.id = rl.raw_event_id
     LEFT JOIN users u ON rl.reviewer_id = u.id
     WHERE rl.raw_event_id = ?
     ORDER BY rl.created_at DESC LIMIT 1`,
    [id]
  ) as any;

  if (!rejection) return Response.json(null, { status: 404 });
  if (!(await canAccessSource(user, Number(rejection.source_id)))) return forbidden();

  const response = { ...rejection };
  delete response.source_id;
  return Response.json(response, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
