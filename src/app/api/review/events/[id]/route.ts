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

  const [[event]] = await pool.query(
    `SELECT re.*, s.name AS source_name, s.slug AS source_slug, s.calendar_source_name
     FROM raw_events re JOIN sources s ON re.source_id = s.id WHERE re.id = ? ${scopeClause}`,
    [id, ...scopeParams]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });

  return Response.json(event);
}
