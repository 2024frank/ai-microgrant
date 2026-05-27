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

export function reviewerSourceScope(user: AuthUser, eventAlias = 're') {
  if (user.role === 'admin') return { clause: '', params: [] as any[] };

  return {
    clause: `
      AND (
        NOT EXISTS (
          SELECT 1 FROM reviewer_sources
          WHERE reviewer_id = ?
        )
        OR ${eventAlias}.source_id IN (
          SELECT source_id FROM reviewer_sources
          WHERE reviewer_id = ?
        )
      )`,
    params: [user.id, user.id],
  };
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

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export function forbidden() {
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}
