import { NextRequest } from 'next/server';
import pool from '@/lib/db';

/**
 * POST /api/cleanup
 * Called by the deployment scheduler. Reviewer feedback is durable training
 * evidence, so reviewed events are never deleted here. Cleanup removes drafts
 * that missed their approval deadline (every session already ended), drafts
 * abandoned with no sessions, and large poster blobs that are no longer needed.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret || secret !== expectedSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runCleanup();
}

// Vercel Cron invokes GET with Authorization: Bearer <CRON_SECRET>.
export async function GET(req: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret || req.headers.get('authorization') !== `Bearer ${expectedSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runCleanup();
}

async function runCleanup() {
  const nowUnix = Math.floor(Date.now() / 1000);

  // Snapshot only abandoned, unreviewed drafts before deleting them. Approved,
  // rejected, corrected, and superseded events remain available to the
  // source-scoped feedback policy.
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
     WHERE re.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM field_edit_log x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM rejection_log x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM review_sessions x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM needs_fix x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM communityhub_submissions x WHERE x.raw_event_id = re.id)
       AND (
        (JSON_LENGTH(re.sessions) > 0 AND (
         SELECT MAX(CAST(jt.endTime AS UNSIGNED))
         FROM JSON_TABLE(re.sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
       ) < ?)
        OR ((re.sessions IS NULL OR JSON_LENGTH(re.sessions) = 0)
            AND re.created_at < DATE_SUB(NOW(), INTERVAL 90 DAY))
       )
     GROUP BY re.source_id, s.name
     HAVING COUNT(re.id) > 0`,
    [nowUnix]
  );

  // A pending draft whose final session has ended missed its approval
  // deadline and can never publish; delete it as soon as it expires. Drafts
  // with no sessions have no deadline, so those keep the 90-day grace period.
  const [eventsResult] = await pool.query(
    `DELETE re FROM raw_events re
     WHERE re.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM field_edit_log x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM rejection_log x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM review_sessions x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM needs_fix x WHERE x.raw_event_id = re.id)
       AND NOT EXISTS (SELECT 1 FROM communityhub_submissions x WHERE x.raw_event_id = re.id)
       AND (
         (JSON_LENGTH(re.sessions) > 0 AND (
           SELECT MAX(CAST(jt.endTime AS UNSIGNED))
           FROM JSON_TABLE(re.sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
         ) < ?)
         OR ((re.sessions IS NULL OR JSON_LENGTH(re.sessions) = 0)
             AND re.created_at < DATE_SUB(NOW(), INTERVAL 90 DAY))
       )`,
    [nowUnix]
  ) as any;

  // Poster data can be several megabytes. Once a reviewed event is old and no
  // longer active, remove only the blob while retaining its review evidence.
  const [postersResult] = await pool.query(
    `UPDATE raw_events
     SET image_data = NULL
     WHERE image_data IS NOT NULL
       AND status IN ('approved','rejected','superseded')
       AND updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND (
         (JSON_LENGTH(sessions) > 0 AND (
           SELECT MAX(CAST(jt.endTime AS UNSIGNED))
           FROM JSON_TABLE(sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
         ) < ?)
         OR sessions IS NULL
         OR JSON_LENGTH(sessions) = 0
       )`,
    [nowUnix],
  ) as any;

  // The baseline foreign key cascades run deletion to raw_events. Delete only
  // run rows that no retained event references, preserving feedback history.
  const [runsResult] = await pool.query(
    `DELETE ar FROM agent_runs ar
     WHERE ar.started_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
       AND NOT EXISTS (SELECT 1 FROM raw_events re WHERE re.agent_run_id = ar.id)`
  ) as any;

  const deleted = eventsResult.affectedRows;
  console.log(`[cleanup] deleted ${deleted} abandoned drafts, purged ${postersResult.affectedRows} poster blobs, deleted ${runsResult.affectedRows} unreferenced runs`);

  return Response.json({
    ok: true,
    archived_event_counts:  deleted,
    deleted_past_events:    eventsResult.affectedRows,
    deleted_sessionless:    0,
    purged_poster_blobs:     postersResult.affectedRows,
    deleted_old_runs:       runsResult.affectedRows,
  });
}
