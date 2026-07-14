import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import { canAccessSource } from '@/lib/reviewerAccess';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  const { id } = await context.params;
  const [[event]] = await pool.query(
    `SELECT re.*, s.name AS source_name, s.slug AS source_slug, s.calendar_source_name,
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
  return Response.json({
    ...event,
    publishing_email_configured: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(publishingEmail),
  });
}
