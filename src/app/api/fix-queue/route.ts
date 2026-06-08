import { NextRequest } from 'next/server';
import pool from '@/lib/db';

/**
 * GET /api/fix-queue
 * Secured by CRON_SECRET (same secret used by the fix agent).
 * Returns all events currently pending correction.
 */
export async function GET(_req: NextRequest) {
  const auth = _req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const [rows] = await pool.query(
    `SELECT
       nf.id AS fix_id,
       nf.raw_event_id,
       nf.correction_notes,
       nf.sent_by_email,
       nf.created_at AS sent_at,
       re.*,
       s.name  AS source_name,
       s.slug  AS source_slug
     FROM needs_fix nf
     JOIN raw_events re ON re.id = nf.raw_event_id
     JOIN sources s     ON s.id  = nf.source_id
     ORDER BY nf.created_at ASC`
  ) as any;

  // Parse JSON fields
  const events = (rows as any[]).map(row => ({
    ...row,
    sponsors:      pj(row.sponsors,      []),
    post_type_ids: pj(row.post_type_ids, []),
    sessions:      pj(row.sessions,      []),
    buttons:       pj(row.buttons,       []),
    geo_json:      pj(row.geo_json,      null),
  }));

  return Response.json(
    { ok: true, count: events.length, events },
    { headers: { 'Access-Control-Allow-Origin': '*' } }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function pj(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
