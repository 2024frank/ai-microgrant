import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';

/**
 * POST /api/cleanup
 * Called by the deployment scheduler. Reviewer feedback is durable training
 * evidence, so reviewed events are never deleted here. Cleanup removes drafts
 * that missed their approval deadline (every session already ended), drafts
 * abandoned with no sessions, and large poster blobs that are no longer needed.
 */
export async function POST(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runCleanup();
}

// Vercel Cron invokes GET with Authorization: Bearer <CRON_SECRET>.
export async function GET(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runCleanup();
}

async function runCleanup() {
  const nowUnix = Math.floor(Date.now() / 1000);
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [[lock]] = await conn.query(
      `SELECT GET_LOCK('ai-microgrant-cleanup', 0) AS acquired`,
    ) as any;
    locked = lock?.acquired === true || lock?.acquired === 1 || lock?.acquired === '1';
    if (!locked) {
      return Response.json({
        ok: true,
        skipped_locked: true,
        archived_event_counts: 0,
        deleted_past_events: 0,
        deleted_sessionless: 0,
        purged_poster_blobs: 0,
        deleted_old_runs: 0,
      });
    }
    await (conn as any).beginTransaction();

  // Snapshot only abandoned, unreviewed drafts before deleting them. Approved,
  // rejected, corrected, and superseded events remain available to the
  // source-scoped feedback policy.
  await conn.query(
    `INSERT INTO event_stats_archive (source_id, source_name, total, approved, rejected, edited)
     SELECT
       re.source_id,
       s.name,
       COUNT(re.id)                       AS total,
       SUM(re.status = 'approved'
         AND re.communityhub_moderation_status = 'approved') AS approved,
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
  const [eventsResult] = await conn.query(
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
  const [postersResult] = await conn.query(
    `UPDATE raw_events
     SET image_data = NULL,
         image_cdn_url = CASE
           WHEN image_cdn_url LIKE CONCAT('%/api/events/', id, '/poster.jpg%')
             OR image_cdn_url LIKE CONCAT('%/api/events/', id, '/image%')
           THEN NULL ELSE image_cdn_url END
     WHERE image_data IS NOT NULL
       AND status IN ('approved','rejected','superseded','submitted','duplicate')
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

  // Preserved duplicates are quality-evaluation evidence, not drafts; keep
  // them for six months after their last session, then let them expire. The
  // run-comparison report row retains the full payload snapshot regardless.
  const [duplicatesResult] = await conn.query(
    `DELETE re FROM raw_events re
     WHERE re.status = 'duplicate'
       AND re.created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)
       AND (
         (JSON_LENGTH(re.sessions) > 0 AND (
           SELECT MAX(CAST(jt.endTime AS UNSIGNED))
           FROM JSON_TABLE(re.sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
         ) < ?)
         OR re.sessions IS NULL OR JSON_LENGTH(re.sessions) = 0
       )`,
    [nowUnix],
  ) as any;

  // Settled update rows no longer need an embedded image copy. Ambiguous rows
  // retain it because replay/finalization still depends on the durable payload.
  const [outboxPostersResult] = await conn.query(
    `UPDATE communityhub_updates
     SET local_edits=JSON_REMOVE(local_edits, '$.image_data')
     WHERE status IN ('succeeded','failed')
       AND JSON_CONTAINS_PATH(local_edits, 'one', '$.image_data')`,
  ) as any;

  // The baseline foreign key cascades run deletion to raw_events. Delete only
  // run rows that no retained event references, preserving feedback history.
  const [runsResult] = await conn.query(
    `DELETE ar FROM agent_runs ar
     WHERE ar.started_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
       AND NOT EXISTS (SELECT 1 FROM raw_events re WHERE re.agent_run_id = ar.id)`
  ) as any;

  // Run comparisons are FK-free (production id-type drift); remove rows whose
  // agent run has been deleted.
  await conn.query(
    `DELETE c FROM integration_run_comparisons c
     WHERE NOT EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.id = c.agent_run_id)`
  ).catch(() => undefined);

  const deleted = eventsResult.affectedRows;
  await (conn as any).commit();
  console.log(`[cleanup] deleted ${deleted} abandoned drafts, ${duplicatesResult.affectedRows} expired preserved duplicates, purged ${postersResult.affectedRows} poster blobs and ${outboxPostersResult.affectedRows} settled outbox blobs, deleted ${runsResult.affectedRows} unreferenced runs`);

  return Response.json({
    ok: true,
    skipped_locked: false,
    archived_event_counts:  deleted,
    deleted_past_events:    eventsResult.affectedRows,
    deleted_sessionless:    0,
    deleted_expired_duplicates: duplicatesResult.affectedRows,
    purged_poster_blobs:     postersResult.affectedRows,
    purged_outbox_blobs:     outboxPostersResult.affectedRows,
    deleted_old_runs:       runsResult.affectedRows,
  });
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    throw error;
  } finally {
    if (locked) {
      await conn.query(`SELECT RELEASE_LOCK('ai-microgrant-cleanup')`).catch(() => undefined);
    }
    (conn as any).release();
  }
}
