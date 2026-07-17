import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import {
  normalizeBoolean,
  normalizeFullName,
  normalizeRole,
  normalizeSourceIds,
  validateReviewerScope,
  type ManagedRole,
} from '@/lib/userAdminInput';

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function activeValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

async function lastAdminWouldBeRemoved(conn: any, target: any, role: ManagedRole, active: boolean) {
  if (target.role !== 'admin' || !activeValue(target.active)) return false;
  if (role === 'admin' && active) return false;
  const [rows] = await conn.query(
    `SELECT id FROM users
     WHERE role='admin' AND active=1 FOR UPDATE`,
  ) as any;
  return !Array.isArray(rows) || rows.length <= 1;
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (!id) return Response.json({ error: 'Invalid user id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    const candidate = await req.json();
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error();
    body = candidate;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const allowed = new Set(['full_name', 'role', 'active', 'source_ids', 'can_review_all_sources']);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    return Response.json({ error: 'Request contains unsupported fields' }, { status: 400 });
  }
  if (Object.keys(body).length === 0) {
    return Response.json({ error: 'No changes supplied' }, { status: 400 });
  }

  const fullName = body.full_name === undefined ? undefined : normalizeFullName(body.full_name);
  const role = body.role === undefined ? undefined : normalizeRole(body.role);
  const active = body.active === undefined ? undefined : normalizeBoolean(body.active);
  const canReviewAllSources = body.can_review_all_sources === undefined
    ? undefined
    : normalizeBoolean(body.can_review_all_sources);
  const sourceIds = body.source_ids === undefined ? undefined : normalizeSourceIds(body.source_ids);
  if (body.full_name !== undefined && !fullName) {
    return Response.json({ error: 'A valid full_name is required' }, { status: 400 });
  }
  if (body.role !== undefined && !role) {
    return Response.json({ error: 'role must be admin or reviewer' }, { status: 400 });
  }
  if (body.active !== undefined && active === null) {
    return Response.json({ error: 'active must be a boolean' }, { status: 400 });
  }
  if (body.can_review_all_sources !== undefined && canReviewAllSources === null) {
    return Response.json({ error: 'can_review_all_sources must be a boolean' }, { status: 400 });
  }
  if (body.source_ids !== undefined && !sourceIds) {
    return Response.json({ error: 'source_ids must contain unique positive integers' }, { status: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[target]] = await conn.query(
      `SELECT id, email, full_name, role, can_review_all_sources, active
       FROM users WHERE id=? LIMIT 1 FOR UPDATE`,
      [id],
    ) as any;
    if (!target) {
      await (conn as any).rollback();
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const nextRole = (role ?? target.role) as ManagedRole;
    const nextActive = active ?? activeValue(target.active);
    const nextAllSources = nextRole === 'reviewer'
      && (canReviewAllSources ?? activeValue(target.can_review_all_sources));

    if (target.id === user.id && (nextRole !== 'admin' || !nextActive)) {
      await (conn as any).rollback();
      return Response.json({ error: 'You cannot demote or deactivate your own account' }, { status: 400 });
    }
    if (await lastAdminWouldBeRemoved(conn, target, nextRole, nextActive)) {
      await (conn as any).rollback();
      return Response.json({ error: 'At least one active administrator is required' }, { status: 409 });
    }

    let nextSourceIds = sourceIds;
    if (nextRole !== 'reviewer' || nextAllSources) {
      // All-source access and administrator access supersede any historical
      // assignment rows. Clearing them makes the permission model explicit.
      nextSourceIds = [];
    } else if (nextSourceIds === undefined) {
      const [rows] = await conn.query(
        'SELECT source_id FROM reviewer_sources WHERE reviewer_id=? FOR UPDATE',
        [id],
      ) as any;
      nextSourceIds = Array.isArray(rows) ? rows.map(row => Number(row.source_id)) : [];
    }
    nextSourceIds ??= [];
    const scopeError = nextActive
      ? validateReviewerScope({
          role: nextRole,
          sourceIds: nextSourceIds,
          canReviewAllSources: nextAllSources,
        })
      : null;
    if (scopeError) {
      await (conn as any).rollback();
      return Response.json({ error: scopeError }, { status: 400 });
    }

    if (nextSourceIds.length > 0) {
      const [sourceRows] = await conn.query(
        `SELECT id FROM sources WHERE id IN (${nextSourceIds.map(() => '?').join(',')})`,
        nextSourceIds,
      ) as any;
      if (!Array.isArray(sourceRows) || sourceRows.length !== nextSourceIds.length) {
        await (conn as any).rollback();
        return Response.json({ error: 'One or more source_ids do not exist' }, { status: 400 });
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (fullName !== undefined) { sets.push('full_name=?'); values.push(fullName); }
    if (role !== undefined) { sets.push('role=?'); values.push(role); }
    if (active !== undefined) { sets.push('active=?'); values.push(active ? 1 : 0); }
    if (canReviewAllSources !== undefined || role !== undefined) {
      sets.push('can_review_all_sources=?');
      values.push(nextAllSources ? 1 : 0);
    }
    if (sets.length > 0) {
      await conn.query(`UPDATE users SET ${sets.join(',')} WHERE id=?`, [...values, id]);
    }

    if (sourceIds !== undefined || nextRole === 'admin' || nextAllSources) {
      await conn.query('DELETE FROM reviewer_sources WHERE reviewer_id=?', [id]);
      if (nextRole === 'reviewer' && !nextAllSources && nextSourceIds.length > 0) {
        await conn.query(
          'INSERT INTO reviewer_sources (reviewer_id, source_id) VALUES ?',
          [nextSourceIds.map(sourceId => [id, sourceId])],
        );
      }
    }

    const [[updated]] = await conn.query(
      `SELECT id, email, full_name, role, can_review_all_sources, active
       FROM users WHERE id=?`,
      [id],
    ) as any;
    await (conn as any).commit();
    return Response.json(updated);
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    const requestId = randomUUID();
    console.error(`[users/${id}] PATCH request ${requestId} failed:`, error);
    return Response.json({ error: 'Unable to update user', request_id: requestId }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();
  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (!id) return Response.json({ error: 'Invalid user id' }, { status: 400 });
  if (id === user.id) {
    return Response.json({ error: 'Cannot delete your own account' }, { status: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[target]] = await conn.query(
      'SELECT id, role, active FROM users WHERE id=? LIMIT 1 FOR UPDATE',
      [id],
    ) as any;
    if (!target) {
      await (conn as any).rollback();
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (await lastAdminWouldBeRemoved(conn, target, 'reviewer', false)) {
      await (conn as any).rollback();
      return Response.json({ error: 'At least one active administrator is required' }, { status: 409 });
    }

    await conn.query('DELETE FROM reviewer_sources WHERE reviewer_id=?', [id]);
    await conn.query('DELETE FROM notifications WHERE user_id=?', [id]);
    await conn.query('DELETE FROM users WHERE id=?', [id]);
    await (conn as any).commit();
    return Response.json({ ok: true });
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    const requestId = randomUUID();
    console.error(`[users/${id}] DELETE request ${requestId} failed:`, error);
    return Response.json({ error: 'Unable to delete user', request_id: requestId }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
