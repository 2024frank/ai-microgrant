import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';

/**
 * GET /api/admin/comparisons
 *
 * Two-way integration-vs-calendar comparisons recorded per agent run
 * (2026-07-16 meeting, item 1). List mode returns recent runs with counts;
 * ?run_id= returns one run's full report including preserved duplicates,
 * field-level differences, and calendar posts the integration missed.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { searchParams } = new URL(req.url);
  const runIdParam = searchParams.get('run_id');
  if (runIdParam) {
    if (!/^\d+$/.test(runIdParam)) {
      return Response.json({ error: 'Invalid run id' }, { status: 400 });
    }
    const [[row]] = await pool.query(
      `SELECT c.*, s.name AS source_name, s.slug AS source_slug,
              ar.started_at AS run_started_at, ar.finished_at AS run_finished_at,
              ar.status AS run_status
       FROM integration_run_comparisons c
       JOIN sources s ON s.id=c.source_id
       JOIN agent_runs ar ON ar.id=c.agent_run_id
       WHERE c.agent_run_id=? LIMIT 1`,
      [runIdParam],
    ) as any;
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    let report = row.report;
    if (typeof report === 'string') {
      try {
        report = JSON.parse(report);
      } catch {
        report = null;
      }
    }
    return Response.json({ ...row, report });
  }

  const requestedLimit = Number.parseInt(searchParams.get('limit') || '30', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 30;
  const sourceId = searchParams.get('source_id');
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (sourceId && /^\d+$/.test(sourceId)) {
    conditions.push('c.source_id=?');
    params.push(sourceId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT c.id, c.agent_run_id, c.source_id, c.status, c.remote_approved,
            c.remote_pending, c.matched_both, c.integration_only,
            c.calendar_only, c.duplicates_preserved, c.created_at,
            s.name AS source_name, s.slug AS source_slug,
            ar.started_at AS run_started_at, ar.status AS run_status
     FROM integration_run_comparisons c
     JOIN sources s ON s.id=c.source_id
     JOIN agent_runs ar ON ar.id=c.agent_run_id
     ${where}
     ORDER BY c.id DESC
     LIMIT ?`,
    [...params, limit],
  ) as any;

  return Response.json({ comparisons: Array.isArray(rows) ? rows : [] });
}
