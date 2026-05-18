import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const [rows] = await pool.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM raw_events WHERE source_id = s.id)               AS total_events,
       (SELECT SUM(status='approved') FROM raw_events WHERE source_id = s.id) AS total_approved,
       (SELECT MAX(finished_at) FROM agent_runs WHERE source_id = s.id)       AS last_run_at,
       (SELECT status FROM agent_runs WHERE source_id = s.id
        ORDER BY started_at DESC LIMIT 1)                                      AS last_run_status
     FROM sources s ORDER BY s.name ASC`
  ) as any;

  return Response.json(rows);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { name, agent_id, schedule_cron = '0 6 * * *' } = await req.json();

  if (!name?.trim())     return Response.json({ error: 'name is required' },     { status: 400 });
  if (!agent_id?.trim()) return Response.json({ error: 'agent_id is required' }, { status: 400 });

  const [[agentExists]] = await pool.query(
    'SELECT id FROM sources WHERE agent_id = ?', [agent_id.trim()]
  ) as any;
  if (agentExists) {
    return Response.json({ error: 'This agent ID is already assigned to another source' }, { status: 409 });
  }

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const [[slugExists]] = await pool.query('SELECT id FROM sources WHERE slug = ?', [slug]) as any;
  if (slugExists) {
    return Response.json({ error: `A source named "${name}" already exists` }, { status: 409 });
  }

  const [result] = await pool.query(
    `INSERT INTO sources (name, slug, agent_id, schedule_cron, calendar_source_name, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [name.trim(), slug, agent_id.trim(), schedule_cron, name.trim()]
  ) as any;

  const sourceId = result.insertId;
  const [[created]] = await pool.query('SELECT * FROM sources WHERE id = ?', [sourceId]) as any;

  // Kick off first fetch via a separate HTTP call — truly non-blocking on Vercel
  // We don't await this — the source is already saved, return immediately
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
  const token  = req.headers.get('authorization') || '';
  fetch(`${appUrl}/api/agent/trigger/${sourceId}`, {
    method: 'POST',
    headers: { Authorization: token },
  }).catch(() => {}); // fire and forget

  return Response.json({ ...created, initial_fetch: 'triggered' }, { status: 201 });
}
