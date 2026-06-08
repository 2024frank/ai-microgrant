import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { sendReviewNotification } from '@/lib/email';

/**
 * POST /api/notifications/review
 * Called automatically after an agent run completes.
 * Emails all active reviewers about new pending events.
 * Also callable manually by admin.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  // Get all active reviewers
  const [reviewers] = await pool.query(
    `SELECT u.id, u.email, u.full_name,
       GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR '|||') AS source_names
     FROM users u
     LEFT JOIN reviewer_sources rs ON rs.reviewer_id = u.id
     LEFT JOIN sources s ON s.id = rs.source_id
     WHERE u.active = 1 AND u.role = 'reviewer'
     GROUP BY u.id`
  ) as any;

  const results = [];

  for (const reviewer of reviewers) {
    // Get pending count for this reviewer's sources
    const hasAssignedSources = reviewer.source_names;
    let pendingCount: number;
    let sources: { name: string; count: number }[];

    if (hasAssignedSources) {
      const [rows] = await pool.query(
        `SELECT s.name, COUNT(re.id) AS count
         FROM raw_events re
         JOIN sources s ON re.source_id = s.id
         JOIN reviewer_sources rs ON rs.source_id = s.id
         WHERE rs.reviewer_id = ? AND re.status = 'pending'
         GROUP BY s.id`,
        [reviewer.id]
      ) as any;
      sources = rows;
      pendingCount = rows.reduce((sum: number, r: any) => sum + r.count, 0);
    } else {
      // No specific assignment = all sources
      const [rows] = await pool.query(
        `SELECT s.name, COUNT(re.id) AS count
         FROM raw_events re
         JOIN sources s ON re.source_id = s.id
         WHERE re.status = 'pending'
         GROUP BY s.id`,
      ) as any;
      sources = rows;
      pendingCount = rows.reduce((sum: number, r: any) => sum + r.count, 0);
    }

    if (pendingCount === 0) continue; // Don't email if nothing to review

    // Get oldest pending event date (scoped to reviewer's sources if assigned)
    const [[oldest]] = hasAssignedSources
      ? await pool.query(
          `SELECT re.created_at FROM raw_events re
           JOIN reviewer_sources rs ON rs.source_id = re.source_id
           WHERE rs.reviewer_id = ? AND re.status = 'pending'
           ORDER BY re.created_at ASC LIMIT 1`,
          [reviewer.id]
        ) as any
      : await pool.query(
          `SELECT re.created_at FROM raw_events re
           WHERE re.status = 'pending'
           ORDER BY re.created_at ASC LIMIT 1`
        ) as any;

    const oldestDate = oldest
      ? new Date(oldest.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : null;

    try {
      await sendReviewNotification({
        reviewerEmail: reviewer.email,
        reviewerName:  reviewer.full_name,
        pendingCount,
        sources,
        oldestDate,
      });
      results.push({ reviewer: reviewer.email, sent: true, pending: pendingCount });
    } catch (err: any) {
      results.push({ reviewer: reviewer.email, sent: false, error: err.message });
    }
  }

  return Response.json({ notified: results.length, results });
}
