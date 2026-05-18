import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const [rows] = await pool.query('SELECT * FROM sources ORDER BY name ASC') as any;

  const enriched = await Promise.all(rows.map(async (s: any) => {
    try {
      const [[counts]] = await pool.query(
        `SELECT COUNT(*) AS total_events, SUM(status='approved') AS total_approved
         FROM raw_events WHERE source_id = ?`, [s.id]
      ) as any;
      const [[lastRun]] = await pool.query(
        `SELECT status, finished_at FROM agent_runs
         WHERE source_id = ? ORDER BY started_at DESC LIMIT 1`, [s.id]
      ) as any;
      return { ...s, ...counts, last_run_status: lastRun?.status || null, last_run_at: lastRun?.finished_at || null };
    } catch {
      return { ...s, total_events: 0, total_approved: 0, last_run_status: null, last_run_at: null };
    }
  }));

  return Response.json(enriched);
}

export async function POST(req: NextRequest) {
  console.log('[sources POST] start');

  const user = await getAuthUser(req);
  if (!user) { console.log('[sources POST] unauthorized'); return unauthorized(); }
  if (user.role !== 'admin') { console.log('[sources POST] forbidden'); return forbidden(); }

  console.log('[sources POST] parsing body');
  const { name, agent_id, schedule_cron = '0 6 * * *' } = await req.json();

  if (!name?.trim())     return Response.json({ error: 'name is required' },     { status: 400 });
  if (!agent_id?.trim()) return Response.json({ error: 'agent_id is required' }, { status: 400 });

  console.log('[sources POST] checking agent uniqueness');
  const [[agentExists]] = await pool.query(
    'SELECT id FROM sources WHERE agent_id = ?', [agent_id.trim()]
  ) as any;
  if (agentExists) return Response.json({ error: 'This agent ID is already assigned to another source' }, { status: 409 });

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  console.log('[sources POST] checking slug uniqueness');
  const [[slugExists]] = await pool.query('SELECT id FROM sources WHERE slug = ?', [slug]) as any;
  if (slugExists) return Response.json({ error: `A source named "${name}" already exists` }, { status: 409 });

  console.log('[sources POST] inserting');
  const [result] = await pool.query(
    `INSERT INTO sources (name, slug, agent_id, schedule_cron, calendar_source_name, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [name.trim(), slug, agent_id.trim(), schedule_cron, name.trim()]
  ) as any;

  const sourceId = result.insertId;
  console.log('[sources POST] inserted, id:', sourceId);

  const [[created]] = await pool.query('SELECT * FROM sources WHERE id = ?', [sourceId]) as any;

  console.log('[sources POST] returning 201');
  return Response.json({ ...created, initial_fetch: 'pending' }, { status: 201 });
}
