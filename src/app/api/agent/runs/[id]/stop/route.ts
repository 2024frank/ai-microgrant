import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import Anthropic from '@anthropic-ai/sdk';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await context.params;

  const [[run]] = await pool.query('SELECT * FROM agent_runs WHERE id = ?', [id]) as any;
  if (!run) return Response.json({ error: 'Run not found' }, { status: 404 });
  if (run.status !== 'running') return Response.json({ error: 'Run is not active' }, { status: 400 });

  // 1. Flag it stopped so the poll loop (if still alive) aborts on its next check.
  await pool.query(
    `UPDATE agent_runs SET status='stopped', finished_at=NOW() WHERE id=?`, [id]
  );

  // 2. Tear down the Anthropic session so the agent actually stops API-side.
  //    Without this, "stop" only changes our DB while the agent keeps running on
  //    Anthropic and may still POST events. The SDK exposes no cancel — delete is
  //    the only teardown. Best-effort: the session may already be gone.
  if (run.session_id && process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      await (client.beta.sessions as any).delete(run.session_id);
      console.log(`[stop] run=${id} deleted Anthropic session ${run.session_id}`);
    } catch (err: any) {
      console.error(`[stop] run=${id} session delete failed:`, err?.message);
    }
  }

  return Response.json({ ok: true });
}
