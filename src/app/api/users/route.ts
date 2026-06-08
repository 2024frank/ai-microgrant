import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const [users] = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.active, u.created_at,
       JSON_ARRAYAGG(CASE WHEN s.id IS NOT NULL THEN JSON_OBJECT('id', s.id, 'name', s.name) END) AS assigned_sources
     FROM users u
     LEFT JOIN reviewer_sources rs ON rs.reviewer_id = u.id
     LEFT JOIN sources s ON s.id = rs.source_id
     GROUP BY u.id ORDER BY u.full_name ASC`
  ) as any;
  return Response.json(users);
}
