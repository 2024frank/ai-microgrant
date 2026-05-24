import { NextRequest } from 'next/server';
import { adminAuth } from './firebase-admin';
import pool from './db';

export interface AuthUser {
  id:    number;
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

    const [[user]] = await pool.query(
      'SELECT * FROM users WHERE email = ? AND active = 1', [email]
    ) as any;
    if (!user) return null;

    return { id: user.id, uid: decoded.uid, email: user.email, role: user.role, name: user.full_name };
  } catch {
    return null;
  }
}

export function reviewerSourceScope(user: AuthUser, eventAlias = 're') {
  if (user.role !== 'reviewer') return { clause: '', params: [] as any[] };

  return {
    clause: `
      AND (
        NOT EXISTS (
          SELECT 1 FROM reviewer_sources rs2
          WHERE rs2.reviewer_id = ?
        )
        OR ${eventAlias}.source_id IN (
          SELECT rs.source_id FROM reviewer_sources rs
          WHERE rs.reviewer_id = ?
        )
      )`,
    params: [user.id, user.id],
  };
}

export async function canReviewSource(user: AuthUser, sourceId: number | string | null | undefined) {
  if (user.role !== 'reviewer') return true;
  if (sourceId === null || sourceId === undefined) return false;

  const [[scope]] = await pool.query(
    `SELECT
       COUNT(*) AS assignment_count,
       SUM(CASE WHEN source_id = ? THEN 1 ELSE 0 END) AS matching_count
     FROM reviewer_sources
     WHERE reviewer_id = ?`,
    [sourceId, user.id]
  ) as any;

  const assignmentCount = Number(scope?.assignment_count ?? 0);
  const matchingCount   = Number(scope?.matching_count ?? 0);
  return assignmentCount === 0 || matchingCount > 0;
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export function forbidden() {
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}
