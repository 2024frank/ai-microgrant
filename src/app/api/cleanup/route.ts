import { NextRequest } from 'next/server';
import pool from '@/lib/db';

/**
 * POST /api/cleanup
 * Called by GitHub Actions daily cron.
 * Deletes raw_events where ALL sessions have end times in the past.
 * Also cleans up old agent_runs (>90 days).
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret');
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowUnix = Math.floor(Date.now() / 1000);

  // Delete events where every session's end time is in the past
  // sessions is a JSON array like [{"startTime":..., "endTime":...}]
  // We use JSON_EXTRACT to find the max endTime across all sessions
  const [eventsResult] = await pool.query(
    `DELETE FROM raw_events
     WHERE JSON_LENGTH(sessions) > 0
       AND (
         SELECT MAX(CAST(jt.endTime AS UNSIGNED))
         FROM JSON_TABLE(sessions, '$[*]' COLUMNS (endTime VARCHAR(20) PATH '$.endTime')) jt
       ) < ?`,
    [nowUnix]
  ) as any;

  // Also delete events with no sessions that are older than 30 days
  const [noSessionResult] = await pool.query(
    `DELETE FROM raw_events
     WHERE (sessions IS NULL OR JSON_LENGTH(sessions) = 0)
       AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
  ) as any;

  // Clean up agent_runs older than 90 days
  const [runsResult] = await pool.query(
    `DELETE FROM agent_runs WHERE started_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
  ) as any;

  console.log(`[cleanup] deleted ${eventsResult.affectedRows} past events, ${noSessionResult.affectedRows} sessionless events, ${runsResult.affectedRows} old runs`);

  return Response.json({
    ok: true,
    deleted_past_events:      eventsResult.affectedRows,
    deleted_sessionless:      noSessionResult.affectedRows,
    deleted_old_runs:         runsResult.affectedRows,
  });
}
