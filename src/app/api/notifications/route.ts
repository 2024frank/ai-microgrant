import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const [[dbUser]] = await pool.query(
    'SELECT id FROM users WHERE firebase_uid = ?', [user.uid]
  ) as any;
  if (!dbUser) return Response.json({ notifications: [], unread: 0 });

  const [notifications] = await pool.query(
    `SELECT id, type, title, message, raw_event_id, read_at, created_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 50`,
    [dbUser.id]
  ) as any;

  const unread = (notifications as any[]).filter((n: any) => !n.read_at).length;

  return Response.json({ notifications, unread });
}
