import { after, NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { sendWelcomeEmail } from '@/lib/email';

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { email, full_name, role = 'reviewer', source_ids = [] } = await req.json();
  if (!email || !full_name) return Response.json({ error: 'email and full_name required' }, { status: 400 });

  const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]) as any;
  if (existing) return Response.json({ error: 'This email is already registered' }, { status: 409 });

  const [result] = await pool.query(
    `INSERT INTO users (email, full_name, role, active, firebase_uid) VALUES (?, ?, ?, 1, '')`,
    [email.toLowerCase().trim(), full_name.trim(), role]
  ) as any;
  const userId = result.insertId;

  if (source_ids.length > 0) {
    const values = source_ids.map((sid: number) => [userId, sid]);
    await pool.query('INSERT INTO reviewer_sources (reviewer_id, source_id) VALUES ?', [values]);
  }

  // Send welcome email with current queue stats
  const [[{ pendingCount }]] = await pool.query(
    `SELECT COUNT(*) AS pendingCount FROM raw_events WHERE status IN ('pending','pending_fix')`
  ) as any;
  after(async () => {
    try {
      await sendWelcomeEmail({
        email: email.toLowerCase().trim(),
        name: full_name.trim(),
        role,
        pendingCount,
      });
    } catch (error) {
      console.error('Welcome email delivery failed:', error);
    }
  });

  const [[created]] = await pool.query(
    'SELECT id, email, full_name, role, active FROM users WHERE id = ?', [userId]
  ) as any;
  return Response.json(created, { status: 201 });
}
