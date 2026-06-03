import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { canReviewSource, forbidden, getAuthUser, unauthorized } from '@/lib/auth';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;

  const [[rejection]] = await pool.query(
    `SELECT rl.reason_codes, rl.reviewer_note, rl.created_at, re.source_id,
            u.full_name AS reviewer_name
     FROM rejection_log rl
     JOIN raw_events re ON re.id = rl.raw_event_id
     LEFT JOIN users u ON rl.reviewer_id = u.id
     WHERE rl.raw_event_id = ?
     ORDER BY rl.created_at DESC LIMIT 1`,
    [id]
  ) as any;

  if (!rejection) return Response.json(null, { status: 404 });
  if (!(await canReviewSource(user, rejection.source_id))) return forbidden();

  const safeRejection = { ...rejection };
  delete safeRejection.source_id;
  return Response.json(safeRejection);
}
