import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';

export const maxDuration = 60;

/**
 * POST /api/agent/queue-clear?confirm=pending (CRON_SECRET)
 *
 * Deliberately wipes the pending review queue so fresh agent runs with the
 * corrected prompts re-extract every event cleanly (dedup signatures would
 * otherwise pin the old drafts). Only plain pending drafts are removed:
 * corrections in flight, rejected records, preserved duplicates, and
 * everything submitted or published stay untouched. Per-source counts are
 * archived first. Never scheduled; invoked only by an explicit operator
 * dispatch with the confirm parameter.
 */
export async function POST(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (new URL(req.url).searchParams.get('confirm') !== 'pending') {
    return Response.json({
      error: 'Pass confirm=pending to wipe the pending review queue',
    }, { status: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    const [counts] = await conn.query(
      `SELECT re.source_id, s.name AS source_name, COUNT(*) AS total
       FROM raw_events re JOIN sources s ON s.id=re.source_id
       WHERE re.status='pending' AND COALESCE(re.sent_for_correction, 0)=0
       GROUP BY re.source_id, s.name`,
    ) as any;
    const perSource = Array.isArray(counts) ? counts : [];
    for (const row of perSource) {
      await conn.query(
        `INSERT INTO event_stats_archive (source_id, source_name, total, approved, rejected, edited)
         VALUES (?,?,?,0,0,0)`,
        [row.source_id, row.source_name, row.total],
      );
    }

    // FK-free companion tables first; FK-backed audit rows cascade.
    await conn.query(
      `DELETE nf FROM needs_fix nf
       JOIN raw_events re ON re.id=nf.raw_event_id
       WHERE re.status='pending' AND COALESCE(re.sent_for_correction, 0)=0`,
    );
    await conn.query(
      `DELETE n FROM notifications n
       JOIN raw_events re ON re.id=n.raw_event_id
       WHERE re.status='pending' AND COALESCE(re.sent_for_correction, 0)=0`,
    );
    await conn.query(
      `DELETE cs FROM communityhub_submissions cs
       JOIN raw_events re ON re.id=cs.raw_event_id
       WHERE re.status='pending' AND COALESCE(re.sent_for_correction, 0)=0
         AND cs.status IN ('prepared','failed')`,
    );
    const [deleted] = await conn.query(
      `DELETE FROM raw_events
       WHERE status='pending' AND COALESCE(sent_for_correction, 0)=0`,
    ) as any;

    await (conn as any).commit();
    return Response.json({
      ok: true,
      deleted_pending: Number(deleted?.affectedRows || 0),
      per_source: perSource,
    });
  } catch (error) {
    await (conn as any).rollback().catch(() => undefined);
    return Response.json({
      error: error instanceof Error ? error.message : 'Queue clear failed',
    }, { status: 500 });
  } finally {
    (conn as any).release();
  }
}
