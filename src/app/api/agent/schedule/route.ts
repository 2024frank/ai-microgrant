import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { triggerAgentRun, triggerEmailIngest } from '@/lib/agentRunner';
import { sendAgentRunSummary, sendReviewNotification } from '@/lib/email';
import { shouldRunToday } from '@/lib/schedule';

// Vercel Cron hits this — Authorization: Bearer <CRON_SECRET>
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [allSources] = await pool.query(
    'SELECT id, name, schedule_cron, source_type FROM sources WHERE active = 1'
  ) as any;
  // Respect each source's cron schedule. The daily trigger only checks the date
  // fields, so e.g. FAVA '0 6 * * 1' runs Mondays while Apollo '0 6 * * *' runs
  // daily. Each run only ingests NEW events (existing ones are de-duplicated),
  // so "every week" and "when new events appear" are the same scheduled pass.
  const sources = (allSources as any[]).filter((s: any) => shouldRunToday(s.schedule_cron));

  const results: { source: string; status: string; inserted: number; error?: string }[] = [];
  let totalNew = 0;

  // Capture env vars here (guaranteed in route handler context)
  const anthropicKey  = process.env.ANTHROPIC_API_KEY  ?? '';
  const environmentId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '';

  for (const source of sources) {
    // Pre-create the run record so we have a runId to pass
    const [runRes] = await pool.query(
      "INSERT INTO agent_runs (source_id, status) VALUES (?, 'running')", [source.id]
    ) as any;
    const runId = runRes.insertId;

    try {
      const result = source.source_type === 'email'
        ? await triggerEmailIngest(source.id, runId)
        : await triggerAgentRun(source.id, runId, anthropicKey, environmentId);
      results.push({ source: source.name, status: 'ok', inserted: result.inserted });
      totalNew += result.inserted;
    } catch (err: any) {
      results.push({ source: source.name, status: 'error', inserted: 0, error: err.message });
      // Ensure the run record is marked failed even if triggerAgentRun threw before its own catch
      await pool.query(
        "UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=? AND status='running'",
        [JSON.stringify([err.message]), runId]
      ).catch(() => {});
    }
  }

  // Email admin with run summary
  if (process.env.ADMIN_EMAIL && (totalNew > 0 || results.some(r => r.status === 'error'))) {
    sendAgentRunSummary({
      adminEmail: process.env.ADMIN_EMAIL,
      results,
      totalNew,
    }).catch(console.error);
  }

  // Email reviewers about new pending events
  if (totalNew > 0) {
    // Get all active reviewers and notify them
    const [reviewers] = await pool.query(
      `SELECT u.id, u.email, u.full_name FROM users u
       WHERE u.active = 1 AND u.role = 'reviewer'`
    ) as any;

    for (const reviewer of reviewers) {
      const [[{ pending }]] = await pool.query(
        `SELECT COUNT(*) AS pending FROM raw_events re
         LEFT JOIN reviewer_sources rs ON rs.source_id = re.source_id AND rs.reviewer_id = ?
         WHERE re.status = 'pending'
           AND (rs.reviewer_id IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM reviewer_sources WHERE reviewer_id = ?
           ))`,
        [reviewer.id, reviewer.id]
      ) as any;

      if (pending > 0) {
        sendReviewNotification({
          reviewerEmail: reviewer.email,
          reviewerName:  reviewer.full_name,
          pendingCount:  pending,
          sources:       results.filter(r => r.status === 'ok').map(r => ({ name: r.source, count: r.inserted })),
          oldestDate:    null,
        }).catch(console.error);
      }
    }
  }

  return Response.json({ ran: results.length, totalNew, results });
}
