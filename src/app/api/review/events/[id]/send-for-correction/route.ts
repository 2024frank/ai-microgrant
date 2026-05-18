import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized } from '@/lib/auth';

const FIX_AGENT_SOURCE_ID = 6; // "Fixed Events" source

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id: eventId } = await context.params;
  const { correction_notes } = await req.json();

  if (!correction_notes?.trim()) {
    return Response.json({ error: 'correction_notes required' }, { status: 400 });
  }

  const [[event]] = await pool.query(
    'SELECT id, source_id, title, status, calendar_source_url FROM raw_events WHERE id = ?', [eventId]
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });

  const [[dbUser]] = await pool.query(
    'SELECT id, email FROM users WHERE firebase_uid = ?', [user.uid]
  ) as any;

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    // Upsert into needs_fix (UNIQUE on raw_event_id prevents dupes)
    await conn.query(
      `INSERT INTO needs_fix (raw_event_id, source_id, correction_notes, sent_by_user_id, sent_by_email)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         correction_notes = VALUES(correction_notes),
         sent_by_user_id  = VALUES(sent_by_user_id),
         sent_by_email    = VALUES(sent_by_email),
         created_at       = CURRENT_TIMESTAMP`,
      [eventId, event.source_id, correction_notes.trim(), dbUser?.id ?? null, dbUser?.email ?? null]
    );

    // Mark the event so the queue shows it differently
    await conn.query(
      "UPDATE raw_events SET sent_for_correction = 1, status = 'pending_fix' WHERE id = ?",
      [eventId]
    );

    // Log as activity in review_sessions
    await conn.query(
      `INSERT INTO review_sessions (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch)
       VALUES (?, ?, 'sent_for_correction', 0, 0)`,
      [eventId, dbUser?.id ?? null]
    );

    await (conn as any).commit();

    // Fire fix agent in background — don't block the response
    const anthropicKey   = process.env.ANTHROPIC_API_KEY   ?? '';
    const environmentId  = process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '';
    const [runResult] = await pool.query(
      "INSERT INTO agent_runs (source_id, status) VALUES (?, 'running')",
      [FIX_AGENT_SOURCE_ID]
    ) as any;
    const runId = runResult.insertId;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ai-microgrant-research-oberlin.vercel.app';
    const fixMessage = [
      `A reviewer has sent an event back for correction. Fix it now.`,
      ``,
      `Event title: ${event.title}`,
      `raw_event_id: ${eventId}`,
      `Correction notes from reviewer: ${correction_notes.trim()}`,
      ...(event.calendar_source_url ? [`Original source URL: ${event.calendar_source_url}`] : []),
      ``,
      `Fetch the full event details from: ${appUrl}/api/fix-queue`,
      ``,
      `CRITICAL: When you POST the fixed event to ${appUrl}/api/ingest/fixed-events, you MUST include:`,
      `  Header: x-ingest-secret: ${process.env.INGEST_SECRET}`,
      `  "fixedFromEventId": "${eventId}"`,
      `This exact value (${eventId}) links the fix back to the original event so the reviewer gets notified.`,
      `Do NOT use any other ID — use only ${eventId} as the fixedFromEventId.`,
      ``,
      `Also include a "fixSummary" field in the event payload — one short sentence describing what you changed`,
      `to address the reviewer's correction notes. Example: "Added phone number 440-775-8000 from source page."`,
      `This summary will appear in the reviewer's bell notification so they know what was done.`,
    ].join('\n');

    import('@/lib/agentRunner').then(({ triggerAgentRun }) => {
      triggerAgentRun(FIX_AGENT_SOURCE_ID, runId, anthropicKey, environmentId, fixMessage).catch((err: Error) => {
        console.error(`Fix agent run ${runId} failed:`, err.message);
        pool.query(
          "UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?",
          [JSON.stringify([err.message]), runId]
        );
      });
    });

    return Response.json({ ok: true, fix_run_id: runId });
  } catch (err: any) {
    await (conn as any).rollback();
    return Response.json({ error: err.message }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
