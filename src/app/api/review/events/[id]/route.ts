import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import { canAccessSource } from '@/lib/reviewerAccess';
import { eventWithoutImageData } from '@/lib/eventImagePrivacy';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  const { id } = await context.params;
  const [[event]] = await pool.query(
    `SELECT re.id, re.source_id, re.agent_run_id, re.event_type, re.title,
            re.description, re.extended_description, re.sponsors,
            re.post_type_ids, re.sessions, re.location_type, re.location,
            re.place_id, re.place_name, re.room_num, re.url_link, re.display,
            re.screen_ids, re.buttons, re.contact_email, re.email, re.phone,
            re.website, re.image_cdn_url,
            (re.image_data IS NOT NULL AND re.image_data <> '') AS has_image_data,
            re.calendar_source_name, re.calendar_source_url,
            re.ingested_post_url, re.geo_scope, re.geo_json, re.status,
            re.communityhub_post_id, re.communityhub_moderation_status,
            re.communityhub_checked_at, re.communityhub_moderation_error,
            re.corrected_from_id, re.superseded_by_id, re.sent_for_fix_by,
            re.sent_for_correction, re.dedup_key, re.validation_errors,
            re.field_notes, re.duplicate_of_id, re.communityhub_match,
            re.publish_started_at, re.created_at, re.updated_at,
            s.name AS source_name, s.slug AS source_slug,
            s.source_kind AS source_kind, s.source_type AS source_type,
            latest_rejection.reason_codes AS rejection_reason_codes,
            latest_rejection.reviewer_note AS rejection_reviewer_note,
            latest_rejection.created_at AS rejected_at
     FROM raw_events re
     JOIN sources s ON re.source_id = s.id
     LEFT JOIN rejection_log latest_rejection
       ON latest_rejection.id = (
         SELECT rl.id FROM rejection_log rl
         WHERE rl.raw_event_id = re.id
         ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1
       )
     WHERE re.id = ?`, [id]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!await canAccessSource(user, Number(event.source_id))) return forbidden();
  const publishingEmail = (
    process.env.COMMUNITYHUB_EMAIL?.trim()
    || event.email
    || process.env.ADMIN_EMAIL?.trim()
    || ''
  );
  const safeEvent = eventWithoutImageData(event);
  return Response.json({
    ...safeEvent,
    publishing_email_configured: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(publishingEmail),
  });
}
