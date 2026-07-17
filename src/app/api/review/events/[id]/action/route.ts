import { createHash } from 'node:crypto';
import { createEventMediaToken } from '@/lib/eventMediaToken';
import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { isEventType } from '@/lib/eventTypes';
import {
  buildCommunityHubPayload,
  CommunityHubPayloadValidationError,
  type CommunityHubPayload,
} from '@/lib/communityHubPayload';
import { canAccessSource } from '@/lib/reviewerAccess';
import { validatePublicHttpUrl } from '@/lib/publicHttpUrl';
import { isRejectionReasonCode } from '@/lib/rejectionReasons';
import { extractCommunityHubPostId } from '@/lib/communityHubResponse';
import { fieldAuditValue } from '@/lib/fieldAuditValue';
import {
  eventImageEditErrorStatus,
  normalizeEventImageEdit,
  type NormalizedEventImageEdit,
} from '@/lib/eventImageEdits';
import { boundedEventSnapshot } from '@/lib/eventImagePrivacy';
import { recoverSucceededCommunityHubSubmission } from '@/lib/communityHubSubmissions';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';
const EDITABLE_FIELDS = [
  'event_type', 'title', 'description', 'extended_description', 'sessions',
  'location_type', 'location', 'place_id', 'place_name', 'room_num', 'url_link',
  'sponsors', 'post_type_ids', 'geo_scope', 'contact_email', 'phone', 'website',
  'image_cdn_url', 'buttons', 'display', 'screen_ids', 'calendar_source_name',
  'calendar_source_url',
] as const;

const PAYLOAD_FIELD_MAP: Partial<Record<(typeof EDITABLE_FIELDS)[number], keyof CommunityHubPayload>> = {
  event_type: 'eventType',
  title: 'title',
  description: 'description',
  extended_description: 'extendedDescription',
  sessions: 'sessions',
  location_type: 'locationType',
  location: 'location',
  place_id: 'placeId',
  place_name: 'placeName',
  room_num: 'roomNum',
  url_link: 'urlLink',
  sponsors: 'sponsors',
  post_type_ids: 'postTypeId',
  contact_email: 'contactEmail',
  phone: 'phone',
  website: 'website',
  image_cdn_url: 'image_cdn_url',
  buttons: 'buttons',
  display: 'display',
  screen_ids: 'screensIds',
  calendar_source_name: 'calendarSourceName',
  calendar_source_url: 'calendarSourceUrl',
};

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch {
      // Plain string.
    }
  }
  return String(value);
}

function asEdits(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mergeAllowListed(event: any, edits: Record<string, unknown>) {
  const merged = { ...event };
  for (const field of EDITABLE_FIELDS) {
    if (edits[field] !== undefined) merged[field] = edits[field];
  }
  return merged;
}

function buildPayload(eventId: string, merged: any): CommunityHubPayload {
  let imageUrl: string | undefined;
  const mediaValue = merged.image_data || merged.image_cdn_url;
  if (mediaValue) {
    if (merged.image_cdn_url && !String(merged.image_cdn_url).startsWith('data:')) {
      const originalImageUrl = validatePublicHttpUrl(String(merged.image_cdn_url));
      if (!originalImageUrl.success) {
        throw new CommunityHubPayloadValidationError([{
          path: 'image_cdn_url',
          code: originalImageUrl.code === 'non_public_host' ? 'non_public_url' : 'invalid_url',
          message: `must use a public HTTP or HTTPS host (${originalImageUrl.message})`,
        }]);
      }
    }
    const appUrl = (
      process.env.APP_URL
      || process.env.NEXT_PUBLIC_APP_URL
      || 'https://ai-microgrant-research-oberlin.vercel.app'
    ).replace(/\/$/, '');
    const mediaToken = createEventMediaToken(eventId, String(mediaValue));
    imageUrl = `${appUrl}/api/events/${eventId}/poster.jpg?media_token=${encodeURIComponent(mediaToken)}`;
  }

  return buildCommunityHubPayload({
    ...merged,
    email:
      process.env.COMMUNITYHUB_EMAIL?.trim()
      || merged.email
      || process.env.ADMIN_EMAIL?.trim()
      || '',
    subscribe: true,
    public: '1',
    image_cdn_url: imageUrl,
  });
}

function payloadHash(payload: CommunityHubPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function persistedEditValue(
  field: (typeof EDITABLE_FIELDS)[number],
  rawValue: unknown,
  payload: CommunityHubPayload,
): string {
  // CommunityHub receives our signed proxy URL, but the database must retain
  // the original external source (or data URI) that the proxy serves. Storing
  // the outbound proxy URL here would make the image endpoint fetch itself.
  if (field === 'image_cdn_url') return canonicalValue(rawValue);
  const payloadField = PAYLOAD_FIELD_MAP[field];
  return canonicalValue(payloadField ? payload[payloadField] : rawValue);
}

async function readCommunityHubResponse(response: Response) {
  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    return { raw: '' };
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText.slice(0, 500) };
  }
}

async function bestEffortQuery(sql: string, params: unknown[]): Promise<void> {
  try {
    await pool.query(sql, params);
  } catch {
    // Preserve the primary response when diagnostic state cannot be persisted.
  }
}

function permanentClientFailure(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export type CommunityHubFailureCode =
  | 'communityhub_image_download'
  | 'communityhub_validation'
  | 'communityhub_error';

/**
 * Classify a CommunityHub rejection so an image-download failure is never
 * mistaken for a missing-field or long-description validation problem
 * (2026-07-16 meeting, item 8).
 */
export function classifyCommunityHubFailure(body: unknown): CommunityHubFailureCode {
  let text = '';
  try {
    text = (typeof (body as any)?.raw === 'string'
      ? (body as any).raw
      : JSON.stringify(body ?? {})).toLowerCase();
  } catch {
    return 'communityhub_error';
  }
  // "failed to download image from URL" is a fetch failure; a validation
  // message that merely mentions an image URL field ("imageCdnUrl must be a
  // valid image URL") is not.
  if (text.includes('image') && /(download|fetch)/.test(text)) {
    return 'communityhub_image_download';
  }
  if (/(required|invalid|missing|must be|too long|too short)/.test(text)) {
    return 'communityhub_validation';
  }
  return 'communityhub_error';
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin' && user.role !== 'reviewer') return forbidden();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const edits = asEdits(body.edits);
  const timeSpentSec = Number.isFinite(body.time_spent_sec)
    ? Math.max(0, Math.round(body.time_spent_sec))
    : null;
  const action = body.action;
  const { id: eventId } = await context.params;

  if (action !== 'approve' && action !== 'reject') {
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }
  if (edits.event_type !== undefined && !isEventType(edits.event_type)) {
    return Response.json({ error: 'Invalid event type' }, { status: 400 });
  }
  if (action === 'reject') {
    if (!Array.isArray(edits.reason_codes) || edits.reason_codes.length === 0) {
      return Response.json({ error: 'reason_codes required' }, { status: 400 });
    }
    if (edits.reason_codes.length > 10 || !edits.reason_codes.every(isRejectionReasonCode)) {
      return Response.json({ error: 'Invalid rejection reason code' }, { status: 400 });
    }
    edits.reason_codes = [...new Set(edits.reason_codes)];
  }

  const [[event]] = await pool.query('SELECT * FROM raw_events WHERE id = ?', [eventId]) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!(await canAccessSource(user, Number(event.source_id)))) return forbidden();

  const [[dbUser]] = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = ?',
    [user.uid],
  ) as any;
  const reviewerId = dbUser?.id ?? null;

  if (action === 'reject') {
    if (event.status !== 'pending') {
      return Response.json({ error: 'Can only reject an event awaiting review' }, { status: 409 });
    }
    const conn = await pool.getConnection();
    try {
      await (conn as any).beginTransaction();
      const [claim] = await conn.query(
        `UPDATE raw_events SET status='rejected'
         WHERE id=? AND status='pending'`,
        [eventId],
      ) as any;
      if (!claim.affectedRows) {
        await (conn as any).rollback();
        return Response.json({ error: 'Event was already reviewed' }, { status: 409 });
      }
      await conn.query(
        `INSERT INTO rejection_log
         (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note, event_title, event_snapshot)
         VALUES (?,?,?,?,?,?,?)`,
        [
          eventId,
          event.source_id,
          reviewerId,
          JSON.stringify(edits.reason_codes),
          String(edits.reviewer_note ?? '').slice(0, 2000),
          event.title,
          JSON.stringify(boundedEventSnapshot(event)),
        ],
      );
      await conn.query(
        `INSERT INTO review_sessions
         (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch)
         VALUES (?,?,'rejected',?,0)`,
        [eventId, reviewerId, timeSpentSec],
      );
      await (conn as any).commit();
      return Response.json({ ok: true });
    } catch (error) {
      await (conn as any).rollback();
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unable to reject event' },
        { status: 500 },
      );
    } finally {
      (conn as any).release();
    }
  }

  if (!['pending', 'publishing'].includes(event.status)) {
    return Response.json({ error: 'Event is already publishing or reviewed' }, { status: 409 });
  }

  let payload!: CommunityHubPayload;
  let hash = '';
  let normalizedImageEdit: NormalizedEventImageEdit | undefined;
  const originalStatus = 'pending';
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    const [[currentEvent]] = await conn.query(
      'SELECT * FROM raw_events WHERE id=? LIMIT 1 FOR UPDATE',
      [eventId],
    ) as any;
    if (!currentEvent) throw new Error('Event disappeared while preparing publication');
    if (!['pending', 'publishing'].includes(currentEvent.status)) {
      await (conn as any).rollback();
      return Response.json({ error: 'Event is already publishing or reviewed' }, { status: 409 });
    }

    // A previous request may have reached CommunityHub and durably recorded
    // its post ID before local finalization failed. Link that exact post before
    // considering this request's (possibly changed) edits; never issue a
    // second POST for the same intake record.
    const recoveredSubmission = await recoverSucceededCommunityHubSubmission(
      conn,
      eventId,
      { reviewerId, timeSpentSec },
    );
    if (recoveredSubmission) {
      await (conn as any).commit();
      return Response.json({
        ok: true,
        already_submitted: true,
        status: 'submitted',
        moderation_status: 'pending',
        communityhub_post_id: recoveredSubmission.postId,
        communityhub: recoveredSubmission.response,
      });
    }

    // `prepared` proves the process never claimed permission to send the HTTP
    // request. A retry can safely retire that abandoned intent and reclaim the
    // local event. Once an intent is `sending`, its outcome stays locked until
    // an operator links or explicitly releases it.
    const [preparedRows] = await conn.query(
      `SELECT id FROM communityhub_submissions
       WHERE raw_event_id=? AND status='prepared'
       ORDER BY id DESC FOR UPDATE`,
      [eventId],
    ) as any;
    if (Array.isArray(preparedRows) && preparedRows.length > 0) {
      await conn.query(
        `UPDATE communityhub_submissions
         SET status='failed', error_message='Prepared submission was safely superseded before dispatch'
         WHERE raw_event_id=? AND status='prepared'`,
        [eventId],
      );
      await conn.query(
        `UPDATE raw_events SET status='pending', publish_started_at=NULL
         WHERE id=? AND status='publishing'`,
        [eventId],
      );
      currentEvent.status = 'pending';
    }

    // Claim only after checking for a recorded remote success. This lets an
    // immediate retry finish a failed local finalization even while the normal
    // five-minute publishing lease is still fresh.
    const [claim] = await conn.query(
      `UPDATE raw_events
       SET status='publishing', publish_started_at=NOW(), validation_errors=NULL
       WHERE id=? AND (
         status='pending'
         OR (status='publishing' AND publish_started_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
       )`,
      [eventId],
    ) as any;
    if (!claim.affectedRows) {
      await (conn as any).rollback();
      return Response.json({ error: 'Event is already publishing or reviewed' }, { status: 409 });
    }

    const merged = mergeAllowListed(currentEvent, edits);
    try {
      const explicitImageEdit = Object.hasOwn(edits, 'image_cdn_url');
      const effectiveImage = explicitImageEdit
        ? edits.image_cdn_url
        : currentEvent.image_cdn_url || currentEvent.image_data || null;
      normalizedImageEdit = await normalizeEventImageEdit(effectiveImage);
      merged.image_cdn_url = normalizedImageEdit.imageCdnUrl;
      merged.image_data = normalizedImageEdit.imageData
        // A remote poster URL may already have been materialized to stored
        // bytes by an earlier attempt; keep serving those bytes.
        || (!explicitImageEdit && currentEvent.image_data) || null;

      // Materialize a remote poster into stored bytes BEFORE contacting
      // CommunityHub. CommunityHub downloads the poster through our proxy
      // after the submission response; if the proxy still had to re-fetch a
      // third-party URL at that moment, an expired or hotlink-protected image
      // would surface later as CommunityHub's opaque "failed to download
      // image from URL". Materializing now turns that class of failure into
      // an immediate, field-specific reviewer error instead.
      if (merged.image_cdn_url && !merged.image_data) {
        try {
          const { loadImageAsJpeg } = await import('@/lib/safeRemoteImage');
          const jpeg = await loadImageAsJpeg(String(merged.image_cdn_url));
          merged.image_data = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
        } catch (imageError) {
          await (conn as any).rollback();
          const imageCode = imageError !== null && typeof imageError === 'object' && 'code' in imageError
            ? String((imageError as { code?: unknown }).code || 'FETCH_FAILED')
            : 'FETCH_FAILED';
          return Response.json({
            error: 'The event image could not be downloaded from its source URL. Fix or remove the image before publishing.',
            error_code: 'image_download_failed',
            image_error: imageCode,
          }, { status: 422 });
        }
      }
      // Keep the persisted columns and the signed media token in lockstep
      // with the bytes the proxy will actually serve.
      if (merged.image_data && normalizedImageEdit.imageData !== merged.image_data) {
        normalizedImageEdit = {
          ...normalizedImageEdit,
          imageData: String(merged.image_data),
          mediaValue: String(merged.image_data),
        };
      }
      payload = buildPayload(eventId, merged);
    } catch (error) {
      if (
        error instanceof TypeError
        || (error !== null && typeof error === 'object' && 'code' in error)
      ) {
        await (conn as any).rollback();
        const status = eventImageEditErrorStatus(error);
        return Response.json({
          error: error instanceof Error ? error.message : 'Invalid event image',
        }, { status });
      }
      if (error instanceof CommunityHubPayloadValidationError) {
        await (conn as any).rollback();
        await bestEffortQuery(
          'UPDATE raw_events SET validation_errors = ? WHERE id = ?',
          [JSON.stringify(error.issues), eventId],
        );
        return Response.json(
          { error: 'CommunityHub payload validation failed', validation_errors: error.issues },
          { status: 422 },
        );
      }
      throw error;
    }
    hash = payloadHash(payload);

    // Unknown outcomes block the whole event, not only an identical payload.
    // Changing one field must never create a new hash that bypasses the lock
    // and risks a duplicate public post.
    const [unresolvedRows] = await conn.query(
      `SELECT id FROM communityhub_submissions
       WHERE raw_event_id=? AND status IN ('sending','accepted_unreconciled')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [eventId],
    ) as any;
    if (Array.isArray(unresolvedRows) && unresolvedRows.length > 0) {
      await (conn as any).rollback();
      return Response.json({
        error: 'A prior CommunityHub submission has an unresolved outcome and requires manual reconciliation',
        submission_state: 'unresolved',
        retry_safe: false,
      }, { status: 409 });
    }

    for (const field of EDITABLE_FIELDS) {
      if (edits[field] === undefined) continue;
      if (field === 'image_cdn_url' && normalizedImageEdit) {
        const oldValue = canonicalValue(currentEvent.image_data || currentEvent.image_cdn_url);
        const newValue = canonicalValue(
          normalizedImageEdit.imageData || normalizedImageEdit.imageCdnUrl,
        );
        if (oldValue !== newValue) {
          await conn.query(
            `INSERT INTO field_edit_log
             (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
             VALUES (?,?,?,?,?,?)`,
            [
              eventId,
              currentEvent.source_id,
              reviewerId,
              field,
              fieldAuditValue(oldValue),
              fieldAuditValue(newValue),
            ],
          );
        }
        continue;
      }
      const oldValue = canonicalValue(currentEvent[field]);
      const newValue = persistedEditValue(field, edits[field], payload);
      if (oldValue === newValue) continue;
      await conn.query(
        `INSERT INTO field_edit_log
         (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
         VALUES (?,?,?,?,?,?)`,
        [
          eventId,
          currentEvent.source_id,
          reviewerId,
          field,
          fieldAuditValue(oldValue),
          fieldAuditValue(newValue),
        ],
      );
    }

    const updateFields = EDITABLE_FIELDS.filter(
      field => field !== 'image_cdn_url' && edits[field] !== undefined,
    );
    if (updateFields.length > 0) {
      const values = updateFields.map(field => persistedEditValue(field, edits[field], payload));
      await conn.query(
        `UPDATE raw_events SET ${updateFields.map(field => `${field}=?`).join(',')} WHERE id=?`,
        [...values, eventId],
      );
    }
    if (normalizedImageEdit && (
      Object.hasOwn(edits, 'image_cdn_url')
      || canonicalValue(currentEvent.image_cdn_url) !== canonicalValue(normalizedImageEdit.imageCdnUrl)
      || canonicalValue(currentEvent.image_data) !== canonicalValue(normalizedImageEdit.imageData)
    )) {
      await conn.query(
        `UPDATE raw_events SET image_cdn_url=?, image_data=? WHERE id=?`,
        [normalizedImageEdit.imageCdnUrl, normalizedImageEdit.imageData, eventId],
      );
    }

    await conn.query(
      `INSERT INTO communityhub_submissions
       (raw_event_id, payload_hash, status, payload, reviewer_id)
       VALUES (?,?,'prepared',?,?)
       ON DUPLICATE KEY UPDATE
         status=IF(status IN ('succeeded','accepted_unreconciled'), status, 'prepared'),
         payload=VALUES(payload), reviewer_id=VALUES(reviewer_id),
         error_message=NULL`,
      [eventId, hash, JSON.stringify(payload), reviewerId],
    );
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback();
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to prepare publication' },
      { status: 500 },
    );
  } finally {
    (conn as any).release();
  }

  // This durable transition is the boundary after which a missing HTTP
  // response is ambiguous. Never start fetch unless the exact prepared intent
  // was successfully claimed as sending.
  try {
    const [dispatchClaim] = await pool.query(
      `UPDATE communityhub_submissions SET status='sending'
       WHERE raw_event_id=? AND payload_hash=? AND status='prepared'`,
      [eventId, hash],
    ) as any;
    if (Number(dispatchClaim?.affectedRows || 0) !== 1) {
      throw new Error('Submission dispatch intent could not be claimed');
    }
  } catch {
    return Response.json({
      error: 'CommunityHub submission is prepared but dispatch did not start. It will be safely recovered before retry.',
      submission_state: 'prepared',
      retry_safe: false,
      recoverable: true,
    }, { status: 503 });
  }

  let response: Response;
  try {
    response = await fetch(`${CH_BASE}/post/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CommunityHub request failed';
    // A network error is ambiguous: CommunityHub may have accepted the POST
    // even though its response never reached us. Keep the durable `sending`
    // state and block automatic retry rather than risk a duplicate public post.
    await bestEffortQuery(
      `UPDATE communityhub_submissions SET error_message=?
       WHERE raw_event_id=? AND payload_hash=? AND status='sending'`,
      [message, eventId, hash],
    );
    return Response.json({
      error: message,
      submission_state: 'unknown',
      retry_safe: false,
    }, { status: 502 });
  }

  const communityHub = await readCommunityHubResponse(response);
  if (!response.ok) {
    const failureCode = classifyCommunityHubFailure(communityHub);
    const message = `CommunityHub ${response.status} [${failureCode}]: ${communityHub.raw ?? JSON.stringify(communityHub)}`;
    if (!permanentClientFailure(response.status)) {
      // A timeout, conflict, rate limit, or server error can arrive after the
      // remote service committed the POST. Preserve the unresolved lease and
      // require lookup/manual linkage instead of making a duplicate retry safe.
      await bestEffortQuery(
        `UPDATE communityhub_submissions SET error_message=?
         WHERE raw_event_id=? AND payload_hash=? AND status='sending'`,
        [message, eventId, hash],
      );
      return Response.json({
        error: message,
        error_code: failureCode,
        submission_state: 'unknown',
        retry_safe: false,
        response_status: response.status,
      }, { status: 502 });
    }
    await bestEffortQuery(
      `UPDATE communityhub_submissions
       SET status='failed', error_message=?
       WHERE raw_event_id=? AND payload_hash=?`,
      [message, eventId, hash],
    );
    await bestEffortQuery(
      `UPDATE raw_events SET status=?, publish_started_at=NULL
       WHERE id=? AND status='publishing'`,
      [originalStatus, eventId],
    );
    return Response.json({ error: message, error_code: failureCode }, { status: 502 });
  }

  const communityHubPostId = extractCommunityHubPostId(communityHub);
  if (!communityHubPostId) {
    await bestEffortQuery(
      `UPDATE communityhub_submissions
       SET status='accepted_unreconciled', response=?,
           error_message='CommunityHub returned 2xx without a usable post id'
       WHERE raw_event_id=? AND payload_hash=?`,
      [JSON.stringify(communityHub), eventId, hash],
    );
    return Response.json({
      error: 'CommunityHub accepted the submission but did not return a usable post id. Manual reconciliation is required before retrying.',
      external_submission_succeeded: true,
      submission_state: 'accepted_unreconciled',
      retry_safe: false,
    }, { status: 503 });
  }
  // Record the external success first. A retry can now repair local state
  // without issuing a second CommunityHub POST.
  try {
    const [recorded] = await pool.query(
      `UPDATE communityhub_submissions
       SET status='succeeded', response=?, communityhub_post_id=?, error_message=NULL
       WHERE raw_event_id=? AND payload_hash=?`,
      [JSON.stringify(communityHub), communityHubPostId, eventId, hash],
    ) as any;
    if (Number(recorded?.affectedRows || 0) !== 1) {
      throw new Error('Submission outbox row was not found');
    }
  } catch {
    return Response.json({
      error: 'CommunityHub accepted the post, but its success could not be recorded. Manual reconciliation is required before retrying.',
      external_submission_succeeded: true,
      communityhub_post_id: communityHubPostId,
      retry_safe: false,
    }, { status: 503 });
  }

  let finalConn: Awaited<ReturnType<typeof pool.getConnection>>;
  try {
    finalConn = await pool.getConnection();
  } catch {
    return Response.json({
      error: 'CommunityHub accepted the post, but local finalization could not start. Retry safely to reconcile it.',
      recoverable: true,
    }, { status: 503 });
  }
  try {
    await (finalConn as any).beginTransaction();
    const [finalized] = await finalConn.query(
      `UPDATE raw_events
       SET status='submitted', communityhub_post_id=?, validation_errors=NULL,
           publish_started_at=NULL, communityhub_moderation_status='pending',
           communityhub_checked_at=NULL, communityhub_moderation_error=NULL
       WHERE id=? AND status='publishing'`,
      [communityHubPostId, eventId],
    ) as any;
    if (Number(finalized?.affectedRows || 0) !== 1) {
      throw new Error('Publication claim no longer owns the event');
    }
    await finalConn.query(
      `INSERT INTO review_sessions
       (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch, ch_response)
       VALUES (?,?,'approved',?,1,?)`,
      [eventId, reviewerId, timeSpentSec, JSON.stringify(communityHub)],
    );
    await (finalConn as any).commit();
  } catch {
    await (finalConn as any).rollback();
    return Response.json(
      {
        error: 'CommunityHub accepted the post, but local finalization is pending. Retry safely to reconcile it.',
        recoverable: true,
      },
      { status: 503 },
    );
  } finally {
    (finalConn as any).release();
  }

  return Response.json({
    ok: true,
    status: 'submitted',
    moderation_status: 'pending',
    communityhub_post_id: communityHubPostId,
    communityhub: communityHub,
  });
}
