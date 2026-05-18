import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  const { id } = await context.params;

  const body    = await req.json();
  const allowed = ['name','agent_id','schedule_cron','active'];
  const updates: Record<string, any> = {};
  for (const k of allowed) { if (body[k] !== undefined) updates[k] = body[k]; }
  if (!Object.keys(updates).length) return Response.json({ error: 'No valid fields' }, { status: 400 });

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await pool.query(`UPDATE sources SET ${setClauses} WHERE id = ?`, [...Object.values(updates), id]);
  const [[updated]] = await pool.query('SELECT * FROM sources WHERE id = ?', [id]) as any;
  return Response.json(updated);
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  const { id } = await context.params;

  await pool.query('DELETE FROM agent_runs WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM reviewer_sources WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM raw_events WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM sources WHERE id = ?', [id]);

  return Response.json({ ok: true });
}
