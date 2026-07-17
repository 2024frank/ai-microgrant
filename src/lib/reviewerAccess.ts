import pool from './db';
import type { AuthUser } from './auth';

/** Reviewers are global only through an explicit permission; otherwise deny by default. */
export async function canAccessSource(user: AuthUser, sourceId: number): Promise<boolean> {
  if (user.role === 'admin' || user.canReviewAllSources) return true;
  if (!Number.isSafeInteger(sourceId) || sourceId < 1) return false;

  try {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM reviewer_sources
         WHERE reviewer_id=? AND source_id=?
       ) AS allowed`,
      [user.id, sourceId],
    ) as any;
    const rows = Array.isArray(result) ? result[0] : null;
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.allowed === true || row?.allowed === 1 || row?.allowed === '1';
  } catch (error) {
    console.error('[reviewer access] assignment lookup failed:', error);
    return false;
  }
}
