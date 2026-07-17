import { after, NextRequest } from 'next/server';
import pool from '@/lib/db';
import { forbidden, getAuthUser, unauthorized } from '@/lib/auth';
import { canAccessSource } from '@/lib/reviewerAccess';
import { correctionPrompt } from '@/lib/correctionRuns';
import { agentSessionMaxMinutes, sessionlessRunStaleMinutes } from '@/lib/agentRunPolicy';
import { enqueueAgentContinuation } from '@/lib/agentContinuation';

export const maxDuration = 300;

type CorrectionOriginStatus = 'pending' | 'rejected';

function isDuplicateEntry(error: any): boolean {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

async function bestEffortQuery(sql: string, params: unknown[]): Promise<void> {
  try {
    await pool.query(sql, params);
  } catch {
    // The primary correction outcome remains the response of record.
  }
}

async function notifyCorrectionFailure(
  event: any,
  dbUser: any,
  runId: number,
  message: string,
  restoreStatus: CorrectionOriginStatus,
) {
  const correctionStatus = restoreStatus === 'rejected' ? 'rejected' : 'pending_fix';
  let restoredOwnedRequest = false;
  let conn: Awaited<ReturnType<typeof pool.getConnection>> | null = null;
  try {
    conn = await pool.getConnection();
    await (conn as any).beginTransaction();
    const [[lockedEvent]] = await conn.query(
      `SELECT re.id, re.source_id, re.status, re.sent_for_correction
       FROM raw_events re
       JOIN agent_runs owner
         ON owner.id=?
        AND owner.source_id=re.source_id
        AND owner.correction_event_id=re.id
       WHERE re.id=?
       LIMIT 1 FOR UPDATE`,
      [runId, event.id],
    ) as any;
    let newerActiveRun: any = null;
    if (lockedEvent) {
      const [[row]] = await conn.query(
        `SELECT id FROM agent_runs
         WHERE source_id=? AND correction_event_id=?
           AND id<>? AND status='running'
         LIMIT 1`,
        [lockedEvent.source_id, event.id, runId],
      ) as any;
      newerActiveRun = row ?? null;
    }

    if (
      lockedEvent
      && !newerActiveRun
      && lockedEvent.status === correctionStatus
      && isEnabledFlag(lockedEvent.sent_for_correction)
    ) {
      const [restore] = await conn.query(
        `UPDATE raw_events
         SET status=?, sent_for_correction=0
         WHERE id=? AND status=? AND sent_for_correction=1`,
        [restoreStatus, event.id, correctionStatus],
      ) as any;
      restoredOwnedRequest = Boolean(restore.affectedRows);
      if (restoredOwnedRequest) {
        await conn.query('DELETE FROM needs_fix WHERE raw_event_id=?', [event.id]);
      }
    }
    await (conn as any).commit();
  } catch {
    if (conn) await (conn as any).rollback().catch(() => undefined);
    // A newer request owns the row or cleanup will be retried by the scheduler.
  } finally {
    if (conn) (conn as any).release();
  }
  await bestEffortQuery(
    `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
     WHERE id=? AND status IN ('running','completed')`,
    [JSON.stringify([message]), runId],
  );
  if (dbUser?.id && restoredOwnedRequest) {
    await bestEffortQuery(
      `INSERT INTO notifications (user_id, type, title, message, raw_event_id)
       VALUES (?, 'fix_failed', ?, ?, ?)`,
      [
        dbUser.id,
        `Correction failed: ${String(event.title).slice(0, 120)}`,
        restoreStatus === 'rejected'
          ? 'The correction agent could not produce a reviewable draft. The original record remains in Rejected.'
          : 'The correction agent could not produce a reviewable draft. The original event is back in the queue for manual review.',
        event.id,
      ],
    );
  }
}

async function correctionWasApplied(eventId: number, sourceId: number, runId: number) {
  const [[row]] = await pool.query(
    `SELECT corrected.id
     FROM raw_events original
     JOIN raw_events corrected
       ON corrected.id = original.superseded_by_id
      AND corrected.corrected_from_id = original.id
      AND corrected.source_id = original.source_id
      AND corrected.agent_run_id = ?
     LEFT JOIN needs_fix nf ON nf.raw_event_id = original.id
     WHERE original.id = ? AND original.source_id = ?
       AND original.status = 'superseded'
       AND nf.raw_event_id IS NULL
     LIMIT 1`,
    [runId, eventId, sourceId],
  ) as any;
  return Boolean(row?.id);
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
  const correctionNotes = typeof body?.correction_notes === 'string'
    ? body.correction_notes.replace(/\0/g, '').trim().slice(0, 2000)
    : '';
  if (!correctionNotes) {
    return Response.json({ error: 'correction_notes required' }, { status: 400 });
  }

  const { id: eventId } = await context.params;
  const [[event]] = await pool.query(
    `SELECT re.*, s.active AS source_active,
            latest_rejection.reason_codes AS rejection_reason_codes,
            latest_rejection.reviewer_note AS rejection_reviewer_note
     FROM raw_events re JOIN sources s ON s.id=re.source_id
     LEFT JOIN rejection_log latest_rejection
       ON latest_rejection.id = (
         SELECT rl.id FROM rejection_log rl
         WHERE rl.raw_event_id = re.id
         ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1
       )
     WHERE re.id=?`,
    [eventId],
  ) as any;
  if (!event) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!(await canAccessSource(user, Number(event.source_id)))) return forbidden();
  if (!(event.source_active === true || event.source_active === 1 || event.source_active === '1')) {
    return Response.json({ error: 'The event source is disabled' }, { status: 409 });
  }

  const [[dbUser]] = await pool.query(
    'SELECT id, email FROM users WHERE firebase_uid = ?',
    [user.uid],
  ) as any;

  const sessionlessStaleMinutes = sessionlessRunStaleMinutes();
  const sessionMaxMinutes = agentSessionMaxMinutes();
  await pool.query(
    `UPDATE agent_runs SET status='failed', finished_at=NOW(),
       error_log=JSON_ARRAY(
         CASE WHEN session_id IS NULL
           THEN 'Recovered expired correction-run start lease'
           ELSE 'Correction agent session exceeded its absolute runtime limit'
         END
       )
     WHERE source_id=? AND status='running'
       AND (
         (session_id IS NULL
           AND started_at < DATE_SUB(NOW(), INTERVAL ${sessionlessStaleMinutes} MINUTE))
         OR
         (session_id IS NOT NULL
           AND started_at < DATE_SUB(NOW(), INTERVAL ${sessionMaxMinutes} MINUTE))
       )`,
    [event.source_id],
  );

  // A terminated `after()` callback can leave either origin marked as having
  // correction work. Recover it whenever no active run owns this exact event;
  // this also repairs older orphans whose needs_fix row is already missing.
  if (
    event.status === 'pending_fix'
    || (event.status === 'rejected' && isEnabledFlag(event.sent_for_correction))
  ) {
    const [recovered] = await pool.query(
      `UPDATE raw_events re
       SET re.status=CASE WHEN re.status='pending_fix' THEN 'pending' ELSE 'rejected' END,
           re.sent_for_correction=0
       WHERE re.id=?
         AND (re.status='pending_fix' OR (re.status='rejected' AND re.sent_for_correction=1))
         AND NOT EXISTS (
           SELECT 1 FROM agent_runs ar
           WHERE ar.source_id=re.source_id
             AND ar.correction_event_id=re.id
             AND ar.status='running'
         )`,
      [event.id],
    ) as any;
    if (recovered.affectedRows) {
      await bestEffortQuery(
        `DELETE FROM needs_fix
         WHERE raw_event_id=?
           AND NOT EXISTS (
             SELECT 1 FROM agent_runs ar
             WHERE ar.source_id=? AND ar.correction_event_id=? AND ar.status='running'
           )`,
        [event.id, event.source_id, event.id],
      );
      event.status = event.status === 'pending_fix' ? 'pending' : 'rejected';
      event.sent_for_correction = 0;
    } else {
      return Response.json(
        { error: 'A correction is already running for this event', retryable: true },
        { status: 409 },
      );
    }
  }

  if (event.status !== 'pending' && event.status !== 'rejected') {
    return Response.json({ error: 'Only pending or rejected events can be sent for correction' }, { status: 409 });
  }
  if (event.status === 'rejected' && event.superseded_by_id) {
    return Response.json({ error: 'This rejected record already has a corrected replacement' }, { status: 409 });
  }
  const originalStatus = event.status as CorrectionOriginStatus;

  let runId: number;
  try {
    const [runResult] = await pool.query(
      `INSERT INTO agent_runs (source_id, status, correction_event_id)
       VALUES (?, 'running', ?)`,
      [event.source_id, event.id],
    ) as any;
    runId = Number(runResult.insertId);
  } catch (error) {
    if (isDuplicateEntry(error)) {
      return Response.json({
        error: 'This source already has an active agent run; retry the correction after it finishes',
        retryable: true,
      }, { status: 409 });
    }
    return Response.json({ error: 'Unable to claim a correction run' }, { status: 500 });
  }

  let conn: Awaited<ReturnType<typeof pool.getConnection>>;
  try {
    conn = await pool.getConnection();
  } catch (error) {
    await bestEffortQuery(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
       WHERE id=? AND status='running'`,
      [JSON.stringify([error instanceof Error ? error.message : 'Unable to acquire database connection']), runId],
    );
    return Response.json({ error: 'Unable to queue correction' }, { status: 500 });
  }

  try {
    await (conn as any).beginTransaction();
    await conn.query(
      `INSERT INTO needs_fix
       (raw_event_id, source_id, correction_notes, sent_by_user_id, sent_by_email)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source_id=VALUES(source_id),
         correction_notes=VALUES(correction_notes),
         sent_by_user_id=VALUES(sent_by_user_id),
         sent_by_email=VALUES(sent_by_email),
         created_at=CURRENT_TIMESTAMP`,
      [eventId, event.source_id, correctionNotes, dbUser?.id ?? null, dbUser?.email ?? null],
    );
    const [claim] = await conn.query(
      `UPDATE raw_events SET sent_for_correction=1, status=?, updated_at=NOW()
       WHERE id=? AND status=?`,
      [originalStatus === 'rejected' ? 'rejected' : 'pending_fix', eventId, originalStatus],
    ) as any;
    if (!claim.affectedRows) throw new Error('Event is no longer available for correction');
    await conn.query(
      `INSERT INTO review_sessions
       (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch)
       VALUES (?, ?, 'sent_for_correction', 0, 0)`,
      [eventId, dbUser?.id ?? null],
    );
    await (conn as any).commit();
  } catch (error) {
    await (conn as any).rollback();
    await bestEffortQuery(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
      [JSON.stringify([error instanceof Error ? error.message : 'Unable to queue correction']), runId],
    );
    return Response.json({ error: 'Unable to queue correction' }, { status: 500 });
  } finally {
    (conn as any).release();
  }

  const prompt = correctionPrompt(event, correctionNotes);
  const origin = new URL(
    process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || req.url,
  ).origin;
  after(async () => {
    try {
      const { triggerAgentRun } = await import('@/lib/agentRunner');
      const result = await triggerAgentRun(
        Number(event.source_id),
        runId,
        process.env.ANTHROPIC_API_KEY ?? '',
        process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '',
        prompt,
        { expectedCorrectionEventId: Number(event.id) },
      );
      if (result.pending) {
        await enqueueAgentContinuation(origin, [runId]).catch(error => {
          console.error(`[correction] could not enqueue continuation for run=${runId}:`, error);
        });
        return;
      }
      if (!(await correctionWasApplied(
        Number(event.id),
        Number(event.source_id),
        runId,
      ))) {
        throw new Error('Correction agent did not return a reviewable event');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Correction agent failed';
      console.error(`[correction] run=${runId} failed:`, message);
      await notifyCorrectionFailure(event, dbUser, runId, message, originalStatus);
    }
  });

  return Response.json({ ok: true, fix_run_id: runId, message: 'Correction agent started' }, { status: 202 });
}
