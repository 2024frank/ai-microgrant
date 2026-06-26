import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { canReviewSource, getAuthUser, unauthorized, forbidden } from '@/lib/auth';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;

  const [[event]] = await pool.query(
    'SELECT source_id FROM raw_events WHERE id = ?',
    [id]
  ) as any;
  if (!event) return Response.json(null, { status: 404 });
  if (!(await canReviewSource(user, event.source_id))) return forbidden();

  const [[rejection]] = await pool.query(
    `SELECT rl.reason_codes, rl.reviewer_note, rl.created_at,
            u.full_name AS reviewer_name
     FROM rejection_log rl
     LEFT JOIN users u ON rl.reviewer_id = u.id
     WHERE rl.raw_event_id = ?
     ORDER BY rl.created_at DESC LIMIT 1`,
    [id]
  ) as any;

  if (!rejection) return Response.json(null, { status: 404 });
  return Response.json(rejection);
}
