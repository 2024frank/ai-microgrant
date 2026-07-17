import { randomUUID } from 'node:crypto';
import { after, NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { sendWelcomeEmail } from '@/lib/email';
import {
  normalizeBoolean,
  normalizeEmail,
  normalizeFullName,
  normalizeRole,
  normalizeSourceIds,
  validateReviewerScope,
} from '@/lib/userAdminInput';

function isDuplicateEntry(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062;
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  let body: Record<string, unknown>;
  try {
    const candidate = await req.json();
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error();
    body = candidate;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  const fullName = normalizeFullName(body.full_name);
  const role = normalizeRole(body.role, 'reviewer');
  const sourceIds = normalizeSourceIds(body.source_ids);
  const requestedAllSources = normalizeBoolean(body.can_review_all_sources, false);
  if (!email) return Response.json({ error: 'A valid email is required' }, { status: 400 });
  if (!fullName) return Response.json({ error: 'A valid full_name is required' }, { status: 400 });
  if (!role) return Response.json({ error: 'role must be admin or reviewer' }, { status: 400 });
  if (!sourceIds) return Response.json({ error: 'source_ids must contain unique positive integers' }, { status: 400 });
  if (requestedAllSources === null) {
    return Response.json({ error: 'can_review_all_sources must be a boolean' }, { status: 400 });
  }
  const canReviewAllSources = role === 'reviewer' && requestedAllSources;
  const scopeError = validateReviewerScope({ role, sourceIds, canReviewAllSources });
  if (scopeError) return Response.json({ error: scopeError }, { status: 400 });

  const conn = await pool.getConnection();
  let created: any;
  try {
    await (conn as any).beginTransaction();
    const [[existing]] = await conn.query(
      'SELECT id FROM users WHERE email=? LIMIT 1 FOR UPDATE',
      [email],
    ) as any;
    if (existing) {
      await (conn as any).rollback();
      return Response.json({ error: 'This email is already registered' }, { status: 409 });
    }

    if (sourceIds.length > 0) {
      const [sourceRows] = await conn.query(
        `SELECT id FROM sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`,
        sourceIds,
      ) as any;
      if (!Array.isArray(sourceRows) || sourceRows.length !== sourceIds.length) {
        await (conn as any).rollback();
        return Response.json({ error: 'One or more source_ids do not exist' }, { status: 400 });
      }
    }

    const [result] = await conn.query(
      `INSERT INTO users
       (email, full_name, role, can_review_all_sources, active, firebase_uid)
       VALUES (?, ?, ?, ?, 1, NULL)`,
      [email, fullName, role, canReviewAllSources ? 1 : 0],
    ) as any;
    const userId = Number(result.insertId);

    if (role === 'reviewer' && sourceIds.length > 0) {
      await conn.query(
        'INSERT INTO reviewer_sources (reviewer_id, source_id) VALUES ?',
        [sourceIds.map(sourceId => [userId, sourceId])],
      );
    }

    [[created]] = await conn.query(
      `SELECT id, email, full_name, role, can_review_all_sources, active
       FROM users WHERE id=?`,
      [userId],
    ) as any;
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    if (isDuplicateEntry(error)) {
      return Response.json({ error: 'This email is already registered' }, { status: 409 });
    }
    const requestId = randomUUID();
    console.error(`[users/invite] request ${requestId} failed:`, error);
    return Response.json({ error: 'Unable to create user', request_id: requestId }, { status: 500 });
  } finally {
    (conn as any).release();
  }

  let pendingCount = 0;
  try {
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS pendingCount FROM raw_events WHERE status='pending'`,
    ) as any;
    pendingCount = Number(stats?.pendingCount || 0);
  } catch (error) {
    console.error('[users/invite] welcome-email count unavailable:', error);
  }

  after(async () => {
    try {
      await sendWelcomeEmail({ email, name: fullName, role, pendingCount });
    } catch (error) {
      console.error('Welcome email delivery failed:', error);
    }
  });

  return Response.json(created, { status: 201 });
}
