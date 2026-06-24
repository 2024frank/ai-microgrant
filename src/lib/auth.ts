import { NextRequest } from 'next/server';
import { adminAuth } from './firebase-admin';
import pool from './db';

export interface AuthUser {
  uid:   string;
  email: string;
  role:  'admin' | 'reviewer';
  name:  string;
}

export async function getAuthUser(req: NextRequest): Promise<AuthUser | null> {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(header.slice(7));
    const email   = decoded.email?.toLowerCase();
    if (!email) return null;

    let [[user]] = await pool.query(
      'SELECT * FROM users WHERE firebase_uid = ? AND active = 1', [decoded.uid]
    ) as any;

    if (!user) {
      // Fall back to email lookup (covers seeded users with empty firebase_uid)
      [[user]] = await pool.query(
        'SELECT * FROM users WHERE email = ? AND active = 1', [email]
      ) as any;
      // Stamp the uid so future lookups hit the fast path
      if (user) {
        await pool.query('UPDATE users SET firebase_uid = ? WHERE id = ?', [decoded.uid, user.id]);
      }
    }

    if (!user) return null;

    return { uid: decoded.uid, email: user.email, role: user.role, name: user.full_name };
  } catch {
    return null;
  }
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export function forbidden() {
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

export async function canReviewSource(user: AuthUser, sourceId: number | string): Promise<boolean> {
  if (user.role === 'admin') return true;

  const [[row]] = await pool.query(
    `SELECT
       COUNT(*) AS assigned_count,
       SUM(CASE WHEN rs.source_id = ? THEN 1 ELSE 0 END) AS matching_count
     FROM reviewer_sources rs
     JOIN users u ON u.id = rs.reviewer_id
     WHERE u.firebase_uid = ?`,
    [sourceId, user.uid]
  ) as any;

  const assignedCount = Number(row?.assigned_count ?? 0);
  const matchingCount = Number(row?.matching_count ?? 0);
  return assignedCount === 0 || matchingCount > 0;
}
