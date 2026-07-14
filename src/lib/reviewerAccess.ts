import pool from './db';
import type { AuthUser } from './auth';

/**
 * Reviewers with no explicit assignments retain the shared-queue behavior.
 * Once assignments exist, every detail and mutation route enforces them.
 */
export async function canAccessSource(user: AuthUser, sourceId: number): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (!Number.isSafeInteger(sourceId) || sourceId < 1) return false;

  try {
    const result = await pool.query(
      `SELECT
         NOT EXISTS (
           SELECT 1 FROM reviewer_sources rs
           JOIN users u ON u.id = rs.reviewer_id
           WHERE u.firebase_uid = ?
         )
         OR EXISTS (
           SELECT 1 FROM reviewer_sources rs
           JOIN users u ON u.id = rs.reviewer_id
           WHERE u.firebase_uid = ? AND rs.source_id = ?
         ) AS allowed`,
      [user.uid, user.uid, sourceId],
    ) as any;
    const rows = Array.isArray(result) ? result[0] : null;
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.allowed === true || row?.allowed === 1 || row?.allowed === '1';
  } catch (error) {
    console.error('[reviewer access] assignment lookup failed:', error);
    return false;
  }
}
