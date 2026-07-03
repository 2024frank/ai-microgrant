import { NextRequest } from 'next/server';
import pool from '@/lib/db';

/**
 * POST /api/cleanup
 * Called by GitHub Actions daily cron.
 * Snapshots per-source counts into event_stats_archive BEFORE deleting,
 * so historical stats survive event expiry.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret');
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowUnix = Math.floor(Date.now() / 1000);

  // ── 1. Snapshot counts of events that are ABOUT to be deleted ────
  // We capture per-source totals for expiring events before removing them.
  await pool.query(
    `INSERT INTO event_stats_archive (source_id, source_name, total, approved, rejected, edited)
     SELECT
       re.source_id,
       s.name,
       COUNT(re.id)                       AS total,
       SUM(re.status = 'approved')        AS approved,
       SUM(re.status = 'rejected')        AS rejected,
       COUNT(DISTINCT fel.raw_event_id)   AS edited
     FROM raw_events re
     JOIN sources s ON s.id = re.source_id
     LEFT JOIN field_edit_log fel ON fel.raw_event_id = re.id
     WHERE re.status IN ('approved','rejected')
       AND (
       (JSON_LENGTH(re.sessions) > 0 AND (
         SELECT MAX(CAST(jt.endTime AS UNSIGNED))
         FROM JSON_TABLE(re.sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
       ) < ?)
       OR
       ((re.sessions IS NULL OR JSON_LENGTH(re.sessions) = 0)
        AND re.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
     )
     GROUP BY re.source_id, s.name
     HAVING COUNT(re.id) > 0`,
    [nowUnix]
  );

  // ── 2. Delete expired events ──────────────────────────────────────
  const [eventsResult] = await pool.query(
    `DELETE FROM raw_events
     WHERE JSON_LENGTH(sessions) > 0
       AND status IN ('approved','rejected')
       AND (
         SELECT MAX(CAST(jt.endTime AS UNSIGNED))
         FROM JSON_TABLE(sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
       ) < ?`,
    [nowUnix]
  ) as any;

  const [noSessionResult] = await pool.query(
    `DELETE FROM raw_events
     WHERE (sessions IS NULL OR JSON_LENGTH(sessions) = 0)
       AND status IN ('approved','rejected')
       AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
  ) as any;

  // ── 3. Clean up old agent_runs (>90 days) ────────────────────────
  const [runsResult] = await pool.query(
    `DELETE FROM agent_runs WHERE started_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
  ) as any;

  const deleted = eventsResult.affectedRows + noSessionResult.affectedRows;
  console.log(`[cleanup] archived stats for ${deleted} expiring events, deleted ${deleted} events, ${runsResult.affectedRows} old runs`);

  return Response.json({
    ok: true,
    archived_event_counts:  deleted,
    deleted_past_events:    eventsResult.affectedRows,
    deleted_sessionless:    noSessionResult.affectedRows,
    deleted_old_runs:       runsResult.affectedRows,
  });
}
