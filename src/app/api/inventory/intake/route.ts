import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { normalizeContentSessions } from '@/lib/communityHubInventory';
import { isIntakeInventoryTokenValid } from '@/lib/intakeInventoryAccess';
import { isCronAuthorized } from '@/lib/cronAuth';

export const maxDuration = 30;

/**
 * GET /api/inventory/intake?token=… (read token derived from CRON_SECRET)
 *
 * The intake queue as comparison content for duplicate checking. Extraction
 * agents fetch this together with the CommunityHub calendar inventory and
 * drop any event whose entire content (title, sessions, descriptions, source
 * page URL) already appears in either place; the tokened URL is embedded in
 * their private instructions at contract-sync time. The response carries no
 * record IDs, contact details, or reviewer data: IDs must never participate
 * in duplicate matching, and drafts here are unreviewed, which is why the
 * endpoint is not anonymous.
 */
export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  const token = new URL(req.url).searchParams.get('token');
  if (!isIntakeInventoryTokenValid(token) && !isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [rows] = await pool.query(
      `SELECT re.title, re.event_type, re.description, re.extended_description,
              re.calendar_source_url, re.sessions, re.status, s.name AS source_name
       FROM raw_events re
       JOIN sources s ON s.id = re.source_id
       WHERE re.status IN ('pending','submitted','approved','publishing','resubmitted','pending_fix')
       ORDER BY re.id DESC
       LIMIT 2000`,
    ) as any;
    const events = (Array.isArray(rows) ? rows : []).map((row: any) => ({
      title: String(row.title ?? ''),
      event_type: String(row.event_type ?? ''),
      description: String(row.description ?? ''),
      extended_description: String(row.extended_description ?? ''),
      calendar_source_url: String(row.calendar_source_url ?? ''),
      sessions: normalizeContentSessions(row.sessions),
      status: String(row.status ?? ''),
      source: String(row.source_name ?? ''),
    }));
    return Response.json(
      { events, count: events.length },
      { headers: { 'Cache-Control': 'private, max-age=300' } },
    );
  } catch (error) {
    return Response.json({
      error: 'The intake inventory is temporarily unavailable',
      detail: error instanceof Error ? error.message : 'query failed',
    }, { status: 503 });
  }
}
