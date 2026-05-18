import { NextRequest } from 'next/server';
import pool from '@/lib/db';

export async function GET(req: NextRequest) {
  // Setup is disabled after initial bootstrap — re-enable only by deploying
  // with SETUP_ENABLED=1 explicitly set in the environment.
  if (process.env.SETUP_ENABLED !== '1') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const secret = new URL(req.url).searchParams.get('secret');
  if (!secret || secret !== process.env.SETUP_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admins = [
    { email: 'aca@communityhub.cloud', full_name: 'ACA Admin', role: 'admin' },
    { email: 'fkusiapp@oberlin.edu',   full_name: 'Frank Kusi', role: 'admin' },
  ];

  const results = [];
  for (const admin of admins) {
    const [[existing]] = await pool.query(
      'SELECT id FROM users WHERE email = ?', [admin.email]
    ) as any;
    if (existing) {
      await pool.query("UPDATE users SET role='admin', active=1 WHERE email=?", [admin.email]);
      results.push({ email: admin.email, status: 'updated' });
    } else {
      await pool.query(
        `INSERT INTO users (email, full_name, role, active, firebase_uid) VALUES (?,?,?,1,'')`,
        [admin.email, admin.full_name, admin.role]
      );
      results.push({ email: admin.email, status: 'created' });
    }
  }

  return Response.json({ ok: true, results });
}
