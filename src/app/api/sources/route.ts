import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import {
  getNextRunAt,
  SCHEDULE_TIME_ZONE,
  validateCronExpression,
} from '@/lib/schedule';

type AgentRunSummary = {
  id: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  started_at: Date | string;
  finished_at: Date | string | null;
  events_found: number;
  events_extracted: number;
  events_skipped_dup: number;
  events_errored: number;
  error_log: unknown;
  elapsed_sec: number;
};

function errorSummary(errorLog: unknown): string | null {
  if (errorLog === null || errorLog === undefined || errorLog === '') return null;

  let parsed = errorLog;
  if (typeof errorLog === 'string') {
    try {
      parsed = JSON.parse(errorLog);
    } catch {
      return errorLog.slice(0, 500);
    }
  }

  if (Array.isArray(parsed)) {
    const latest = parsed.at(-1);
    if (latest === undefined || latest === null) return null;
    return (typeof latest === 'string' ? latest : JSON.stringify(latest)).slice(0, 500);
  }
  if (typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const candidate = record.message ?? record.error ?? record.detail;
    if (candidate !== undefined) return String(candidate).slice(0, 500);
    return JSON.stringify(parsed).slice(0, 500);
  }
  return String(parsed).slice(0, 500);
}

function operationalState(
  active: unknown,
  scheduleValid: boolean,
  latestRun: AgentRunSummary | undefined,
): { health_status: string; health_reason: string } {
  const isActive = active === true || active === 1 || active === '1';
  if (!isActive) {
    return { health_status: 'disabled', health_reason: 'Source is disabled' };
  }
  if (!scheduleValid) {
    return { health_status: 'invalid_schedule', health_reason: 'Schedule cannot be dispatched' };
  }
  if (!latestRun) {
    return { health_status: 'no_run_history', health_reason: 'No agent run has been recorded' };
  }

  const statusMap: Record<AgentRunSummary['status'], [string, string]> = {
    running: ['running', 'Latest run is still in progress'],
    completed: ['last_run_completed', 'Latest run completed'],
    failed: ['last_run_failed', 'Latest run failed'],
    stopped: ['last_run_stopped', 'Latest run was stopped'],
  };
  const [health_status, health_reason] = statusMap[latestRun.status] ?? [
    'unknown_run_state',
    'Latest run has an unknown status',
  ];
  return { health_status, health_reason };
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  if (user.role !== 'admin') {
    const scopeClause = user.canReviewAllSources
      ? ''
      : `AND EXISTS (
          SELECT 1 FROM reviewer_sources rs
          WHERE rs.reviewer_id=? AND rs.source_id=s.id
        )`;
    const scopeParams = user.canReviewAllSources ? [] : [user.id];
    const [rows] = await pool.query(
      `SELECT s.id, s.name
       FROM sources s
       WHERE s.active=1 ${scopeClause}
       ORDER BY s.name ASC`,
      scopeParams,
    ) as any;
    return Response.json(Array.isArray(rows) ? rows : []);
  }

  try {
    const [rows] = await pool.query('SELECT * FROM sources ORDER BY name ASC') as any;
    const now = new Date();
    const enriched = await Promise.all(rows.map(async (s: any) => {
      const schedule = validateCronExpression(s.schedule_cron);
      const isActive = s.active === true || s.active === 1 || s.active === '1';
      const nextRunAt = isActive && schedule.valid
        ? getNextRunAt(schedule.schedule.expression, now)
        : null;

      try {
        const [countResult, runResult] = await Promise.all([
          pool.query(
            `SELECT COUNT(*) AS total_events,
                    SUM(status='approved' AND communityhub_moderation_status='approved') AS total_approved,
                    SUM(status='submitted') AS total_submitted,
                    SUM(status='pending') AS review_queue,
                    SUM(status='pending') AS pending_review,
                    SUM(status='pending_fix' OR (status='rejected' AND sent_for_correction=1)) AS pending_fix,
                    SUM(status='rejected' AND COALESCE(sent_for_correction, 0)=0) AS total_rejected,
                    SUM(status='resubmitted') AS total_resubmitted,
                    SUM(status='publishing') AS total_publishing,
                    SUM(status='superseded') AS total_superseded,
                    SUM(JSON_LENGTH(COALESCE(validation_errors, JSON_ARRAY())) > 0) AS validation_issues
             FROM raw_events WHERE source_id = ?`,
            [s.id],
          ),
          pool.query(
            `SELECT id, status, started_at, finished_at, events_found, events_extracted,
                    events_skipped_dup, events_errored, error_log,
                    TIMESTAMPDIFF(SECOND, started_at, IFNULL(finished_at, NOW())) AS elapsed_sec
             FROM agent_runs
             WHERE source_id = ? ORDER BY started_at DESC LIMIT 5`,
            [s.id],
          ),
        ]) as any;
        const counts = countResult?.[0]?.[0] ?? {};
        const recentRuns = (Array.isArray(runResult?.[0]) ? runResult[0] : []) as AgentRunSummary[];
        const lastRun = recentRuns[0];
        const state = operationalState(s.active, schedule.valid, lastRun);

        // For the Fixed Events source, attach correction stats
        let fix_stats: any = null;
        if (s.slug === 'fixed-events') {
          const [[fs]] = await pool.query(
            `SELECT
               (SELECT COUNT(*) FROM needs_fix)                                             AS pending_fix,
               (SELECT COUNT(*) FROM raw_events WHERE sent_for_correction = 1)              AS total_sent_for_fix,
               (SELECT COUNT(*) FROM raw_events WHERE corrected_from_id IS NOT NULL)        AS total_fixed,
               (SELECT COUNT(*) FROM raw_events
                WHERE corrected_from_id IS NOT NULL
                  AND status = 'approved'
                  AND communityhub_moderation_status = 'approved') AS fixed_approved
            `
          ) as any;
          fix_stats = fs;
        }

        return {
          ...s,
          ...counts,
          schedule_valid: schedule.valid,
          schedule_error: schedule.valid ? null : schedule.error,
          schedule_timezone: SCHEDULE_TIME_ZONE,
          next_run_at: nextRunAt?.toISOString() ?? null,
          ...state,
          last_run_status: lastRun?.status ?? null,
          last_run_at: lastRun?.finished_at ?? null,
          last_run_started_at: lastRun?.started_at ?? null,
          last_error: errorSummary(lastRun?.error_log),
          recent_runs: recentRuns.map(({ error_log, ...run }) => ({
            ...run,
            error_summary: errorSummary(error_log),
          })),
          fix_stats,
        };
      } catch (error) {
        console.error(`[sources GET] enrichment failed for source ${s.id}:`, error);
        const state = operationalState(s.active, schedule.valid, undefined);
        return {
          ...s,
          total_events: 0,
          total_approved: 0,
          review_queue: 0,
          pending_review: 0,
          pending_fix: 0,
          total_rejected: 0,
          total_resubmitted: 0,
          total_publishing: 0,
          total_superseded: 0,
          validation_issues: 0,
          schedule_valid: schedule.valid,
          schedule_error: schedule.valid ? null : schedule.error,
          schedule_timezone: SCHEDULE_TIME_ZONE,
          next_run_at: nextRunAt?.toISOString() ?? null,
          ...state,
          last_run_status: null,
          last_run_at: null,
          last_run_started_at: null,
          last_error: null,
          recent_runs: [],
          fix_stats: null,
        };
      }
    }));
    return Response.json(enriched);
  } catch (err: any) {
    console.error('[sources GET] DB error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  console.log('[POST /api/sources] 1 - start');

  // Step 1: auth
  let user: any;
  try {
    user = await getAuthUser(req);
  } catch (err: any) {
    console.error('[POST /api/sources] auth error:', err.message);
    return Response.json({ error: 'Auth error: ' + err.message }, { status: 500 });
  }
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  console.log('[POST /api/sources] 2 - auth ok, user:', user.email);

  // Step 2: parse body
  const { name, agent_id, schedule_cron = '0 6 * * *' } = await req.json();
  if (!name?.trim())     return Response.json({ error: 'name is required' },     { status: 400 });
  if (!agent_id?.trim()) return Response.json({ error: 'agent_id is required' }, { status: 400 });
  const schedule = validateCronExpression(schedule_cron);
  if (!schedule.valid) {
    return Response.json({ error: `Invalid schedule: ${schedule.error}` }, { status: 400 });
  }
  console.log('[POST /api/sources] 3 - body ok, name:', name);

  // Step 3: check uniqueness
  try {
    console.log('[POST /api/sources] 4 - checking agent_id uniqueness');
    const [[agentExists]] = await pool.query(
      'SELECT id FROM sources WHERE agent_id = ?', [agent_id.trim()]
    ) as any;
    if (agentExists) return Response.json({ error: 'Agent ID already assigned' }, { status: 409 });

    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    console.log('[POST /api/sources] 5 - checking slug uniqueness');
    const [[slugExists]] = await pool.query('SELECT id FROM sources WHERE slug = ?', [slug]) as any;
    if (slugExists) return Response.json({ error: `Source "${name}" already exists` }, { status: 409 });

    console.log('[POST /api/sources] 6 - inserting');
    const [result] = await pool.query(
      `INSERT INTO sources (name, slug, agent_id, schedule_cron, calendar_source_name, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [name.trim(), slug, agent_id.trim(), schedule.schedule.expression, name.trim()]
    ) as any;

    const sourceId = result.insertId;
    console.log('[POST /api/sources] 7 - inserted, id:', sourceId);

    const [[created]] = await pool.query('SELECT * FROM sources WHERE id = ?', [sourceId]) as any;
    console.log('[POST /api/sources] 8 - done, returning 201');
    return Response.json({ ...created, initial_fetch: 'pending' }, { status: 201 });

  } catch (err: any) {
    console.error('[POST /api/sources] DB error:', err.message);
    return Response.json({ error: 'DB error: ' + err.message }, { status: 500 });
  }
}
