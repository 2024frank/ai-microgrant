import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized } from '@/lib/auth';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const [[dbUser]] = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = ?', [user.uid]
  ) as any;
  if (!dbUser) return Response.json({ error: 'User not found' }, { status: 404 });

  await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?',
    [id, dbUser.id]
  );

  return Response.json({ ok: true });
}
