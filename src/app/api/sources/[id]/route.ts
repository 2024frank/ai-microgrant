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
  const allowed = [
    'name','agent_id','schedule_cron','active',
    // Stable organization metadata (2026-07-16 meeting, item 9) and the
    // original-organization vs aggregator classification (items 10-11).
    'source_kind','org_sponsor_name','org_website','org_phone','org_contact_email',
  ];
  const updates: Record<string, any> = {};
  for (const k of allowed) { if (body[k] !== undefined) updates[k] = body[k]; }
  if (!Object.keys(updates).length) return Response.json({ error: 'No valid fields' }, { status: 400 });

  if (updates.source_kind !== undefined
    && !['original_org', 'aggregator'].includes(updates.source_kind)) {
    return Response.json({ error: 'source_kind must be original_org or aggregator' }, { status: 400 });
  }
  const orgTextFields: Array<[string, number]> = [
    ['org_sponsor_name', 120], ['org_website', 500],
    ['org_phone', 30], ['org_contact_email', 150],
  ];
  for (const [field, maxLength] of orgTextFields) {
    if (updates[field] === undefined) continue;
    if (updates[field] === null || updates[field] === '') {
      updates[field] = null;
      continue;
    }
    if (typeof updates[field] !== 'string' || updates[field].trim().length > maxLength) {
      return Response.json({ error: `${field} must be a string of at most ${maxLength} characters` }, { status: 400 });
    }
    updates[field] = updates[field].trim();
  }
  if (updates.org_website && !/^https?:\/\//i.test(updates.org_website)) {
    return Response.json({ error: 'org_website must be an absolute HTTP or HTTPS URL' }, { status: 400 });
  }
  if (updates.org_contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.org_contact_email)) {
    return Response.json({ error: 'org_contact_email must be a valid email address' }, { status: 400 });
  }

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
