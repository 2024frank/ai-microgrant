import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { getAdminContact } from '@/lib/adminContact';
import { fieldAuditValue } from '@/lib/fieldAuditValue';
import { boundedEventSnapshot } from '@/lib/eventImagePrivacy';
import {
  isPermanentImageFailure,
  planQueueConformance,
  type PendingEventRow,
} from '@/lib/queueConformance';
import type { CommunityHubPayloadIssue } from '@/lib/communityHubPayload';

export const maxDuration = 300;

/**
 * POST /api/agent/queue-conformance (CRON_SECRET)
 *
 * Brings review-queue events ingested before the 2026-07-16 format rules up
 * to the agreed format. For every pending event it either:
 *  - applies the deterministic corrections in place (markers, URL/address
 *    stripping, registration button, exact Apollo titles) and leaves it for
 *    human approval,
 *  - rejects it as "Required fields are missing" or as format-nonconforming
 *    with the reason preserved; the system-corrections dispatcher then routes
 *    it through the AI correction agent once, and the corrected draft returns
 *    to the queue for human approval.
 * It also repairs poster problems ahead of approval: remote images are
 * materialized to stored bytes, permanently unfetchable images are removed
 * (with an audit entry), and transient failures are flagged for the reviewer.
 * Every field change lands in field_edit_log with a NULL reviewer (system).
 */
const EVENTS_PER_SWEEP = 40;
const IMAGE_FETCHES_PER_SWEEP = 8;
const DISCOVERY_RETRY_DAYS = 7;

type SweepItem = {
  event_id: number;
  decision: string;
  changed_fields: string[];
  image_action?: 'materialized' | 'removed' | 'flagged' | 'discovered'
    | 'no_source_image' | 'image_unusable';
  image_note?: string;
  error?: string;
};

function issue(path: string, code: string, message: string): CommunityHubPayloadIssue {
  return { path, code, message };
}

function databaseValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? null;
}

async function handle(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const submitterEmail = process.env.COMMUNITYHUB_EMAIL?.trim()
    || (await getAdminContact())
    || '';

  const [rows] = await pool.query(
    `SELECT re.*, s.slug AS source_slug
     FROM raw_events re
     JOIN sources s ON s.id = re.source_id
     WHERE re.status='pending' AND COALESCE(re.sent_for_correction, 0)=0
     ORDER BY re.id ASC
     LIMIT ${EVENTS_PER_SWEEP}`,
  ) as any;
  const pending = Array.isArray(rows) ? rows as PendingEventRow[] : [];

  let imageBudget = IMAGE_FETCHES_PER_SWEEP;
  const items: SweepItem[] = [];

  for (const row of pending) {
    const item: SweepItem = { event_id: Number(row.id), decision: 'leave', changed_fields: [] };
    items.push(item);
    try {
      const plan = planQueueConformance(row, { submitterEmail });
      item.decision = plan.decision;

      // Poster repair happens only for events staying in the queue; a
      // rejected event's corrected draft re-processes its image from scratch.
      const imageIssues: CommunityHubPayloadIssue[] = [];
      let imageDataUpdate: string | null | undefined;
      let imageUrlUpdate: string | null | undefined;
      const staysInQueue = plan.decision === 'leave' || plan.decision === 'correct';

      // Events extracted without any poster: the source page's own share
      // metadata (og:image) names the image the source uses for this event.
      // Attempts are timestamped so the bounded budget rotates through the
      // backlog instead of retrying the same events forever.
      const hasAnyImage = Boolean((row as any).image_data)
        || Boolean(typeof row.image_cdn_url === 'string' && row.image_cdn_url);
      const sourcePage = typeof (row as any).calendar_source_url === 'string'
        ? String((row as any).calendar_source_url)
        : '';
      const lastDiscovery = (row as any).image_discovery_at
        ? new Date(String((row as any).image_discovery_at)).getTime()
        : 0;
      const discoveryDue = !Number.isFinite(lastDiscovery) || lastDiscovery === 0
        || Date.now() - lastDiscovery > DISCOVERY_RETRY_DAYS * 24 * 3600 * 1000;
      let markDiscoveryAttempt = false;
      if (staysInQueue && !hasAnyImage && discoveryDue
        && /^https?:\/\//i.test(sourcePage) && imageBudget > 0) {
        imageBudget -= 1;
        markDiscoveryAttempt = true;
        try {
          const { discoverSourcePageImage } = await import('@/lib/sourcePageImage');
          const discovered = await discoverSourcePageImage(sourcePage);
          if (!discovered) {
            item.image_action = 'no_source_image';
            item.image_note = 'the source page names no usable share image';
          } else {
            try {
              const { loadImageAsJpeg } = await import('@/lib/safeRemoteImage');
              const jpeg = await loadImageAsJpeg(discovered);
              imageDataUpdate = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
              imageUrlUpdate = discovered;
              item.image_action = 'discovered';
              item.image_note = discovered;
            } catch (imageError) {
              const code = imageError !== null && typeof imageError === 'object' && 'code' in imageError
                ? String((imageError as { code?: unknown }).code || 'FETCH_FAILED')
                : 'FETCH_FAILED';
              item.image_action = 'image_unusable';
              item.image_note = `${discovered} (${code})`;
            }
          }
        } catch (discoveryError) {
          item.image_action = 'no_source_image';
          item.image_note = discoveryError instanceof Error
            ? discoveryError.message
            : 'source page fetch failed';
        }
      }

      const externalImage = typeof row.image_cdn_url === 'string'
        && /^https?:\/\//i.test(row.image_cdn_url)
        && !(row as any).image_data;
      if (staysInQueue && externalImage && imageBudget > 0) {
        imageBudget -= 1;
        try {
          const { loadImageAsJpeg } = await import('@/lib/safeRemoteImage');
          const jpeg = await loadImageAsJpeg(String(row.image_cdn_url));
          imageDataUpdate = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
          item.image_action = 'materialized';
        } catch (error) {
          const code = error !== null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || 'FETCH_FAILED')
            : 'FETCH_FAILED';
          if (isPermanentImageFailure(code)) {
            imageUrlUpdate = null;
            imageIssues.push(issue(
              'image_cdn_url',
              'image_removed_unfetchable',
              `the poster URL could not ever be downloaded (${code}); it was removed so the event can publish without it`,
            ));
            item.image_action = 'removed';
          } else {
            imageIssues.push(issue(
              'image_cdn_url',
              'image_unfetchable',
              `the poster could not be downloaded right now (${code}); retry, replace, or remove it before publishing`,
            ));
            item.image_action = 'flagged';
          }
        }
      }

      const validationErrors = [...plan.validation_errors, ...imageIssues];
      const conn = await pool.getConnection();
      try {
        await (conn as any).beginTransaction();
        const [[locked]] = await conn.query(
          `SELECT * FROM raw_events
           WHERE id=? AND status='pending' AND COALESCE(sent_for_correction, 0)=0
           LIMIT 1 FOR UPDATE`,
          [row.id],
        ) as any;
        if (!locked) {
          await (conn as any).rollback();
          item.decision = 'skipped_state_changed';
          continue;
        }

        const updates: Record<string, unknown> = { ...plan.updates };
        if (imageDataUpdate !== undefined) updates.image_data = imageDataUpdate;
        if (imageUrlUpdate !== undefined) updates.image_cdn_url = imageUrlUpdate;

        for (const [field, value] of Object.entries(updates)) {
          if (field === 'dedup_key' || field === 'image_data') continue;
          if (field === 'image_discovery_at') continue;
          await conn.query(
            `INSERT INTO field_edit_log
             (raw_event_id, source_id, reviewer_id, field_name, old_value, new_value)
             VALUES (?,?,NULL,?,?,?)`,
            [
              row.id,
              row.source_id,
              field,
              fieldAuditValue(String(locked[field] ?? '')),
              fieldAuditValue(typeof value === 'object' && value !== null
                ? JSON.stringify(value)
                : String(value ?? '')),
            ],
          );
        }
        item.changed_fields = Object.keys(updates);

        const fields = Object.keys(updates);
        const setClauses = [
          ...fields.map(field => `${field}=?`),
          'validation_errors=?',
          ...(markDiscoveryAttempt ? ['image_discovery_at=NOW()'] : []),
        ];
        const values = [
          ...fields.map(field => databaseValue(updates[field])),
          validationErrors.length ? JSON.stringify(validationErrors) : null,
        ];
        await conn.query(
          `UPDATE raw_events SET ${setClauses.join(', ')} WHERE id=?`,
          [...values, row.id],
        );

        if (plan.decision === 'reject_missing_required' || plan.decision === 'reject_format') {
          const reasonCode = plan.decision === 'reject_missing_required'
            ? 'missing_fields'
            : 'format_nonconforming';
          await conn.query(
            `UPDATE raw_events SET status='rejected' WHERE id=? AND status='pending'`,
            [row.id],
          );
          await conn.query(
            `INSERT INTO rejection_log
             (raw_event_id, source_id, reviewer_id, reason_codes, reviewer_note,
              event_title, event_snapshot, rejection_origin)
             VALUES (?,?,NULL,?,?,?,?, 'system')`,
            [
              row.id,
              row.source_id,
              JSON.stringify([reasonCode]),
              plan.notes.join(' ').slice(0, 2000),
              String(updates.title ?? row.title).slice(0, 60),
              JSON.stringify(boundedEventSnapshot(locked)),
            ],
          );
        }
        await (conn as any).commit();
      } catch (error) {
        await (conn as any).rollback().catch(() => undefined);
        throw error;
      } finally {
        (conn as any).release();
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : 'conformance failed';
    }
  }

  const count = (decision: string) => items.filter(item => item.decision === decision).length;
  return Response.json({
    ok: items.every(item => !item.error),
    checked: items.length,
    corrected: count('correct'),
    left_conforming: count('leave'),
    rejected_missing_required: count('reject_missing_required'),
    rejected_format: count('reject_format'),
    images_materialized: items.filter(item => item.image_action === 'materialized').length,
    images_removed: items.filter(item => item.image_action === 'removed').length,
    images_flagged: items.filter(item => item.image_action === 'flagged').length,
    image_budget_exhausted: imageBudget === 0,
    errors: items.filter(item => item.error).length,
    items,
  });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
