import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

/**
 * GET /api/admin/activity
 * Key activity feed for the admin dashboard:
 * - Recent reviewer actions with user info
 * - Recent agent runs
 * - Per-reviewer stats
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '20');

  // Recent reviewer actions
  const [recentActions] = await pool.query(
    `SELECT rs.id, rs.action, rs.time_spent_sec, rs.submitted_to_ch, rs.created_at,
            u.full_name AS reviewer_name, u.email AS reviewer_email,
            re.title AS event_title, re.event_type,
            s.name AS source_name
     FROM review_sessions rs
     JOIN users u ON rs.reviewer_id = u.id
     JOIN raw_events re ON rs.raw_event_id = re.id
     JOIN sources s ON re.source_id = s.id
     ORDER BY rs.created_at DESC LIMIT ?`,
    [limit]
  ) as any;

  // Per-reviewer leaderboard (last 30 days)
  const [reviewerStats] = await pool.query(
    `SELECT u.id, u.full_name, u.email,
       COUNT(rs.id)                          AS total_reviewed,
       SUM(rs.action = 'approved')           AS approved,
       SUM(rs.action = 'rejected')           AS rejected,
       ROUND(AVG(rs.time_spent_sec), 1)      AS avg_time_sec,
       MAX(rs.created_at)                    AS last_active,
       SUM(rs.action = 'approved' AND DATE(rs.created_at) = CURDATE()) AS approved_today
     FROM users u
     LEFT JOIN review_sessions rs ON rs.reviewer_id = u.id
       AND rs.created_at >= NOW() - INTERVAL 30 DAY
     WHERE u.role IN ('admin','reviewer') AND u.active = 1
     GROUP BY u.id
     ORDER BY total_reviewed DESC`,
    []
  ) as any;

  // Recent agent runs
  const [recentRuns] = await pool.query(
    `SELECT ar.id, ar.status, ar.started_at, ar.finished_at,
            ar.events_extracted, ar.events_skipped_dup, ar.events_errored,
            TIMESTAMPDIFF(SECOND, ar.started_at, ar.finished_at) AS duration_sec,
            s.name AS source_name
     FROM agent_runs ar
     JOIN sources s ON ar.source_id = s.id
     ORDER BY ar.started_at DESC LIMIT 10`,
    []
  ) as any;

  // System-wide counts today — range predicates keep queries sargable (index-friendly)
  const [[today]] = await pool.query(
    `SELECT
       SUM(status = 'pending')  AS pending,
       SUM(status = 'approved'
         AND communityhub_moderation_status = 'approved'
         AND updated_at >= CURDATE()) AS approved_today,
       SUM(status = 'rejected' AND updated_at >= CURDATE()) AS rejected_today,
       SUM(created_at >= CURDATE()) AS extracted_today
     FROM raw_events`,
    []
  ) as any;

  return Response.json({
    recent_actions:  recentActions,
    reviewer_stats:  reviewerStats,
    recent_runs:     recentRuns,
    today,
  });
}
