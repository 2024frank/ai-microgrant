import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

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

  await pool.query(
    `UPDATE agent_runs SET status='stopped', finished_at=NOW() WHERE id=?`, [id]
  );

  return Response.json({ ok: true });
}
