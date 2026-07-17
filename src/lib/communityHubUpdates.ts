import { randomUUID } from 'node:crypto';
import pool from './db';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';
const UPDATE_CONCURRENCY = 3;
const LOCAL_EDIT_FIELDS = new Set([
  'event_type', 'title', 'description', 'extended_description', 'sessions',
  'location_type', 'location', 'place_id', 'place_name', 'room_num', 'url_link',
  'sponsors', 'post_type_ids', 'geo_scope', 'contact_email', 'phone', 'website',
  'image_cdn_url', 'image_data', 'buttons', 'display', 'screen_ids',
]);

export type CommunityHubUpdateAuditEntry = {
  field: string;
  oldValue: string;
  newValue: string;
};

export type CommunityHubUpdateDraft = {
  rawEventId: number;
  sourceId: number;
  communityHubPostId: string;
  originalStatus: 'approved' | 'resubmitted';
  chEdits: Record<string, unknown>;
  localEdits: Record<string, unknown>;
  auditEntries: CommunityHubUpdateAuditEntry[];
  reviewerId: number | null;
};

type UpdateRow = {
  id: number;
  raw_event_id: number;
  communityhub_post_id: string;
  original_status: 'approved' | 'resubmitted';
  status: 'sending' | 'ambiguous' | 'succeeded' | 'failed';
  ch_edits: unknown;
  local_edits: unknown;
  audit_entries: unknown;
  reviewer_id: number | null;
};

export type CommunityHubUpdateResult = {
  update_id: number;
  event_id: number;
  communityhub_post_id: string;
  status: 'succeeded' | 'ambiguous' | 'failed';
  error?: string;
};

export class CommunityHubUpdateConflictError extends Error {}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || 'unknown error')).slice(0, 1000);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function auditEntries(value: unknown): CommunityHubUpdateAuditEntry[] | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const entries: CommunityHubUpdateAuditEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.field !== 'string'
      || typeof candidate.oldValue !== 'string'
      || typeof candidate.newValue !== 'string'
      || !LOCAL_EDIT_FIELDS.has(candidate.field)
    ) return null;
    entries.push({
      field: candidate.field,
      oldValue: candidate.oldValue,
      newValue: candidate.newValue,
    });
  }
  return entries;
}

function databaseValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null;
}

async function readResponse(response: Response): Promise<unknown> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function permanentClientFailure(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export async function prepareCommunityHubUpdate(
  draft: CommunityHubUpdateDraft,
): Promise<{ id: number; operationKey: string }> {
  const operationKey = randomUUID();
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [claim] = await conn.query(
      `UPDATE raw_events
       SET status='submitted', communityhub_moderation_status='unknown',
           communityhub_checked_at=NULL,
           communityhub_moderation_error='Published edit synchronization pending'
       WHERE id=? AND communityhub_post_id=? AND status=?`,
      [draft.rawEventId, draft.communityHubPostId, draft.originalStatus],
    ) as any;
    if (Number(claim?.affectedRows || 0) !== 1) {
      await (conn as any).rollback();
      throw new CommunityHubUpdateConflictError('Event is no longer available for a published update');
    }
    const [inserted] = await conn.query(
      `INSERT INTO communityhub_updates
       (operation_key, raw_event_id, communityhub_post_id, original_status,
        status, ch_edits, local_edits, audit_entries, reviewer_id)
       VALUES (?,?,?,?,'sending',?,?,?,?)`,
      [
        operationKey,
        draft.rawEventId,
        draft.communityHubPostId,
        draft.originalStatus,
        JSON.stringify(draft.chEdits),
        JSON.stringify(draft.localEdits),
        JSON.stringify(draft.auditEntries),
        draft.reviewerId,
      ],
    ) as any;
    await (conn as any).commit();
    return { id: Number(inserted.insertId), operationKey };
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    throw error;
  } finally {
    (conn as any).release();
  }
}

export async function finalizeCommunityHubUpdate(updateId: number, response: unknown): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[row]] = await conn.query(
      `SELECT id, raw_event_id, communityhub_post_id, original_status, status,
              ch_edits, local_edits, audit_entries, reviewer_id
       FROM communityhub_updates WHERE id=? LIMIT 1 FOR UPDATE`,
      [updateId],
    ) as any as [[UpdateRow | undefined]];
    if (!row) throw new Error('CommunityHub update outbox row was not found');
    if (row.status === 'succeeded') {
      await (conn as any).commit();
      return;
    }
    if (row.status === 'failed') throw new Error('CommunityHub update was already marked failed');

    const localEdits = jsonObject(row.local_edits);
    const entries = auditEntries(row.audit_entries);
    if (!localEdits || !entries || Object.keys(localEdits).some(key => !LOCAL_EDIT_FIELDS.has(key))) {
      throw new Error('CommunityHub update outbox contains invalid local edits');
    }

    for (const entry of entries) {
      await conn.query(
        `INSERT INTO field_edit_log
         (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
         SELECT re.id, re.source_id, ?, ?, ?, ?
         FROM raw_events re WHERE re.id=?`,
        [
          row.reviewer_id,
          entry.field,
          entry.oldValue,
          entry.newValue,
          row.raw_event_id,
        ],
      );
    }

    const fields = Object.keys(localEdits);
    if (fields.length === 0) throw new Error('CommunityHub update outbox has no local edits');
    const [updated] = await conn.query(
      `UPDATE raw_events
       SET ${fields.map(field => `${field}=?`).join(',')},
           status='submitted', communityhub_moderation_status='unknown',
           communityhub_checked_at=NULL, communityhub_moderation_error=NULL
       WHERE id=? AND communityhub_post_id=? AND status='submitted'`,
      [
        ...fields.map(field => databaseValue(localEdits[field])),
        row.raw_event_id,
        row.communityhub_post_id,
      ],
    ) as any;
    if (Number(updated?.affectedRows || 0) !== 1) {
      throw new Error('CommunityHub update no longer owns the submitted event');
    }
    await conn.query(
      `UPDATE communityhub_updates
       SET status='succeeded', response=?, error_message=NULL,
           local_edits=JSON_REMOVE(local_edits, '$.image_data')
       WHERE id=?`,
      [JSON.stringify(response ?? {}), updateId],
    );
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    throw error;
  } finally {
    (conn as any).release();
  }
}

export async function markCommunityHubUpdateAmbiguous(updateId: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE communityhub_updates
     SET status='ambiguous', error_message=?
     WHERE id=? AND status IN ('sending','ambiguous')`,
    [error.slice(0, 2000), updateId],
  );
}

export async function failCommunityHubUpdate(updateId: number, error: string): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[row]] = await conn.query(
      `SELECT id, raw_event_id, original_status, status
       FROM communityhub_updates WHERE id=? LIMIT 1 FOR UPDATE`,
      [updateId],
    ) as any as [[UpdateRow | undefined]];
    if (!row || row.status === 'succeeded') {
      await (conn as any).rollback();
      return;
    }
    await conn.query(
      `UPDATE communityhub_updates
       SET status='failed', error_message=?,
           local_edits=JSON_REMOVE(local_edits, '$.image_data')
       WHERE id=?`,
      [error.slice(0, 2000), updateId],
    );
    await conn.query(
      `UPDATE raw_events
       SET status=?, communityhub_moderation_status=?,
           communityhub_checked_at=NOW(), communityhub_moderation_error=?
       WHERE id=? AND status='submitted'`,
      [
        row.original_status,
        row.original_status === 'approved' ? 'approved' : 'unknown',
        error.slice(0, 2000),
        row.raw_event_id,
      ],
    );
    await (conn as any).commit();
  } catch (failure) {
    await (conn as any).rollback().catch(() => undefined);
    throw failure;
  } finally {
    (conn as any).release();
  }
}

async function markCommunityHubUpdateMissing(updateId: number, error: string): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    const [[row]] = await conn.query(
      `SELECT id, raw_event_id, status
       FROM communityhub_updates WHERE id=? LIMIT 1 FOR UPDATE`,
      [updateId],
    ) as any as [[UpdateRow | undefined]];
    if (!row || row.status === 'succeeded') {
      await (conn as any).rollback();
      return;
    }
    await conn.query(
      `UPDATE communityhub_updates
       SET status='failed', error_message=?,
           local_edits=JSON_REMOVE(local_edits, '$.image_data')
       WHERE id=?`,
      [error.slice(0, 2000), updateId],
    );
    await conn.query(
      `UPDATE raw_events
       SET status='submitted', communityhub_moderation_status='missing',
           communityhub_checked_at=NOW(), communityhub_moderation_error=?
       WHERE id=? AND status='submitted'`,
      [error.slice(0, 2000), row.raw_event_id],
    );
    await (conn as any).commit();
  } catch (failure) {
    await (conn as any).rollback().catch(() => undefined);
    throw failure;
  } finally {
    (conn as any).release();
  }
}

async function executeCommunityHubUpdate(
  postId: string,
  edits: Record<string, unknown>,
): Promise<
  | { ok: true; response: unknown }
  | { ok: false; permanent: boolean; error: string; responseStatus?: number }
> {
  let response: Response;
  try {
    response = await fetch(`${CH_BASE}/post/${encodeURIComponent(postId)}/submit`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, permanent: false, error: safeError(error) };
  }
  const body = await readResponse(response);
  if (response.ok) return { ok: true, response: body };
  return {
    ok: false,
    permanent: permanentClientFailure(response.status),
    responseStatus: response.status,
    error: `CommunityHub ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
  };
}

export async function deliverCommunityHubUpdate(
  updateId: number,
  eventId: number,
  postId: string,
  edits: Record<string, unknown>,
  options: { rollbackOnPermanentFailure?: boolean } = {},
): Promise<CommunityHubUpdateResult & { response?: unknown; response_status?: number }> {
  const outcome = await executeCommunityHubUpdate(postId, edits);
  if (outcome.ok) {
    try {
      await finalizeCommunityHubUpdate(updateId, outcome.response);
      return {
        update_id: updateId,
        event_id: eventId,
        communityhub_post_id: postId,
        status: 'succeeded',
        response: outcome.response,
      };
    } catch (error) {
      const message = `CommunityHub accepted the edit; local finalization failed: ${safeError(error)}`;
      await markCommunityHubUpdateAmbiguous(updateId, message).catch(() => undefined);
      return {
        update_id: updateId,
        event_id: eventId,
        communityhub_post_id: postId,
        status: 'ambiguous',
        error: message,
      };
    }
  }

  if (outcome.responseStatus === 404 || outcome.responseStatus === 410) {
    await markCommunityHubUpdateMissing(updateId, outcome.error);
    return {
      update_id: updateId,
      event_id: eventId,
      communityhub_post_id: postId,
      status: 'failed',
      error: outcome.error,
      response_status: outcome.responseStatus,
    };
  }

  if (outcome.permanent && options.rollbackOnPermanentFailure) {
    await failCommunityHubUpdate(updateId, outcome.error);
    return {
      update_id: updateId,
      event_id: eventId,
      communityhub_post_id: postId,
      status: 'failed',
      error: outcome.error,
      response_status: outcome.responseStatus,
    };
  }
  const unresolvedError = outcome.permanent
    ? `A prior PATCH may have succeeded; later permanent response is not rollback proof. ${outcome.error}`
    : outcome.error;
  await markCommunityHubUpdateAmbiguous(updateId, unresolvedError).catch(() => undefined);
  return {
    update_id: updateId,
    event_id: eventId,
    communityhub_post_id: postId,
    status: 'ambiguous',
    error: unresolvedError,
    response_status: outcome.responseStatus,
  };
}

export async function reconcilePendingCommunityHubUpdates(limit = 10): Promise<CommunityHubUpdateResult[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 25);
  const [rows] = await pool.query(
    `SELECT id, raw_event_id, communityhub_post_id, ch_edits
     FROM communityhub_updates
     WHERE status IN ('sending','ambiguous')
       AND updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
     ORDER BY updated_at ASC, id ASC LIMIT ?`,
    [safeLimit],
  ) as any;
  const pending = Array.isArray(rows) ? rows : [];
  const results: CommunityHubUpdateResult[] = [];
  for (let index = 0; index < pending.length; index += UPDATE_CONCURRENCY) {
    const batch = await Promise.all(pending.slice(index, index + UPDATE_CONCURRENCY).map(async row => {
      const edits = jsonObject(row.ch_edits);
      if (!edits) {
        const message = 'Stored CommunityHub edit payload is invalid';
        await markCommunityHubUpdateAmbiguous(Number(row.id), message).catch(() => undefined);
        return {
          update_id: Number(row.id),
          event_id: Number(row.raw_event_id),
          communityhub_post_id: String(row.communityhub_post_id),
          status: 'ambiguous' as const,
          error: message,
        };
      }
      const delivery = await deliverCommunityHubUpdate(
        Number(row.id),
        Number(row.raw_event_id),
        String(row.communityhub_post_id),
        edits,
        { rollbackOnPermanentFailure: false },
      );
      return {
        update_id: delivery.update_id,
        event_id: delivery.event_id,
        communityhub_post_id: delivery.communityhub_post_id,
        status: delivery.status,
        ...(delivery.error ? { error: delivery.error } : {}),
      };
    }));
    results.push(...batch);
  }
  return results;
}
