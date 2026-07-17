import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const [[rows], [updates]] = await Promise.all([
    pool.query(
      `SELECT cs.id, cs.raw_event_id, cs.status, cs.error_message,
              cs.created_at, cs.updated_at, re.title, s.name AS source_name
       FROM communityhub_submissions cs
       JOIN raw_events re ON re.id=cs.raw_event_id
       JOIN sources s ON s.id=re.source_id
       WHERE cs.status IN ('sending','accepted_unreconciled')
          OR (cs.status='succeeded' AND re.status IN ('pending','publishing'))
       ORDER BY cs.updated_at ASC, cs.id ASC
       LIMIT 100`,
    ),
    pool.query(
      `SELECT cu.id, cu.raw_event_id, cu.status, cu.error_message,
              cu.created_at, cu.updated_at, re.title, s.name AS source_name
       FROM communityhub_updates cu
       JOIN raw_events re ON re.id=cu.raw_event_id
       JOIN sources s ON s.id=re.source_id
       WHERE cu.status IN ('sending','ambiguous','failed')
       ORDER BY cu.updated_at ASC, cu.id ASC
       LIMIT 100`,
    ),
  ]) as any;

  return Response.json({
    submissions: Array.isArray(rows) ? rows : [],
    updates: Array.isArray(updates) ? updates : [],
  }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
