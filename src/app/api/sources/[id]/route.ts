import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { validateCronExpression } from '@/lib/schedule';

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

  if (updates.name !== undefined) {
    if (typeof updates.name !== 'string' || !updates.name.trim()) {
      return Response.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    updates.name = updates.name.trim();
  }
  if (updates.agent_id !== undefined) {
    if (typeof updates.agent_id !== 'string' || !updates.agent_id.trim()) {
      return Response.json({ error: 'agent_id must be a non-empty string' }, { status: 400 });
    }
    updates.agent_id = updates.agent_id.trim();
  }
  if (updates.schedule_cron !== undefined) {
    const schedule = validateCronExpression(updates.schedule_cron);
    if (!schedule.valid) {
      return Response.json({ error: `Invalid schedule: ${schedule.error}` }, { status: 400 });
    }
    updates.schedule_cron = schedule.schedule.expression;
  }
  if (updates.active !== undefined && ![true, false, 0, 1].includes(updates.active)) {
    return Response.json({ error: 'active must be a boolean' }, { status: 400 });
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await pool.query(`UPDATE sources SET ${setClauses} WHERE id = ?`, [...Object.values(updates), id]);
  const [[updated]] = await pool.query('SELECT * FROM sources WHERE id = ?', [id]) as any;
  if (!updated) return Response.json({ error: 'Source not found' }, { status: 404 });
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

  const [[source]] = await pool.query(
    `SELECT s.id,
       (SELECT COUNT(*) FROM raw_events re WHERE re.source_id=s.id) AS event_count,
       (SELECT COUNT(*) FROM agent_runs ar WHERE ar.source_id=s.id) AS run_count
     FROM sources s WHERE s.id=?`,
    [id],
  ) as any;
  if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });

  const eventCount = Number(source.event_count || 0);
  const runCount = Number(source.run_count || 0);
  if (eventCount > 0 || runCount > 0) {
    return Response.json({
      error: 'Source has event or run history and cannot be deleted safely; disable it instead',
      can_disable: true,
      dependencies: { events: eventCount, runs: runCount },
    }, { status: 409 });
  }

  await pool.query('DELETE FROM reviewer_sources WHERE source_id = ?', [id]);
  await pool.query('DELETE FROM sources WHERE id = ?', [id]);

  return Response.json({ ok: true });
}
