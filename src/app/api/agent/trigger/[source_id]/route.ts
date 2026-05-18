import { NextRequest } from 'next/server';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import pool from '@/lib/db';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ source_id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { source_id } = await context.params;
  const sourceId = parseInt(source_id);

  // Check source exists
  const [[source]] = await pool.query(
    'SELECT id, name FROM sources WHERE id = ? AND active = 1', [sourceId]
  ) as any;
  if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });

  // Open a run record immediately so polling can see it
  const [runResult] = await pool.query(
    "INSERT INTO agent_runs (source_id, status) VALUES (?, 'running')", [sourceId]
  ) as any;
  const runId = runResult.insertId;

  // Capture env vars here (guaranteed in route handler) and forward to
  // the dynamically-imported agentRunner so Turbopack can't strip them.
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  const environmentId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '';

  // Fire agent in background — don't await
  import('@/lib/agentRunner').then(({ triggerAgentRun }) => {
    triggerAgentRun(sourceId, runId, anthropicKey, environmentId).catch((err: Error) => {
      console.error(`Agent run ${runId} failed:`, err.message);
      pool.query(
        `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
        [JSON.stringify([err.message]), runId]
      );
    });
  });

  // Return immediately — frontend polls /api/agent/runs for status
  return Response.json({
    ok: true,
    run_id: runId,
    source: source.name,
    message: 'Agent started — poll /api/agent/runs for live status',
  });
}
