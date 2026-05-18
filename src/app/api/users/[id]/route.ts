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

  const { full_name, role, active, source_ids } = await req.json();
  const sets: string[] = [], vals: any[] = [];
  if (full_name !== undefined) { sets.push('full_name = ?'); vals.push(full_name); }
  if (role !== undefined)      { sets.push('role = ?');      vals.push(role); }
  if (active !== undefined)    { sets.push('active = ?');    vals.push(active ? 1 : 0); }

  if (sets.length) { vals.push(id); await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals); }

  if (Array.isArray(source_ids)) {
    await pool.query('DELETE FROM reviewer_sources WHERE reviewer_id = ?', [id]);
    if (source_ids.length > 0) {
      await pool.query('INSERT INTO reviewer_sources (reviewer_id, source_id) VALUES ?', [source_ids.map((s: number) => [id, s])]);
    }
  }

  const [[updated]] = await pool.query('SELECT id, email, full_name, role, active FROM users WHERE id = ?', [id]) as any;
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

  // Prevent self-deletion
  const [[target]] = await pool.query('SELECT id, email FROM users WHERE id = ?', [id]) as any;
  if (!target) return Response.json({ error: 'Not found' }, { status: 404 });

  const [[self]] = await pool.query('SELECT id FROM users WHERE firebase_uid = ?', [user.uid]) as any;
  if (self?.id === target.id) return Response.json({ error: 'Cannot delete your own account' }, { status: 400 });

  await pool.query('DELETE FROM reviewer_sources WHERE reviewer_id = ?', [id]);
  await pool.query('DELETE FROM notifications   WHERE user_id = ?',      [id]);
  await pool.query('DELETE FROM users           WHERE id = ?',            [id]);

  return Response.json({ ok: true });
}
