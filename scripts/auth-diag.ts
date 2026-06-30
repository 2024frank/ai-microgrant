/** Read-only sign-in diagnostic. npx tsx scripts/auth-diag.ts */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';

async function main() {
  const pub = [
    'NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID',
  ];
  console.log('=== client firebase env (NEXT_PUBLIC_*) ===');
  for (const k of pub) {
    const v = process.env[k];
    const show = (k.endsWith('AUTH_DOMAIN') || k.endsWith('PROJECT_ID')) ? ` = ${v ?? ''}` : '';
    console.log(`  ${k}: ${v ? 'SET' : 'MISSING'}${show}`);
  }

  console.log('\n=== admin service account ===');
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  console.log('  FIREBASE_SERVICE_ACCOUNT:', sa ? `SET (len ${sa.length})` : 'MISSING');
  if (sa) {
    try { const j = JSON.parse(sa); console.log(`  parsed OK; project_id=${j.project_id}; client_email=${j.client_email}`); }
    catch (e: any) { console.log('  JSON PARSE FAILED:', e.message); }
  }

  console.log('\n=== verifyIdToken(dummy) — distinguishes config error vs token error ===');
  try {
    const { adminAuth } = await import('../src/lib/firebase-admin');
    await adminAuth.verifyIdToken('dummy.invalid.token');
    console.log('  unexpectedly succeeded');
  } catch (e: any) { console.log('  error:', String(e.message).slice(0, 200)); }

  console.log('\n=== users table ===');
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  const [rows] = await conn.query(
    "SELECT id, email, role, active, (firebase_uid IS NOT NULL AND firebase_uid <> '') AS has_uid FROM users ORDER BY id"
  ) as any;
  for (const u of rows as any[]) console.log(`  #${u.id} ${u.email}  role=${u.role} active=${u.active} has_uid=${u.has_uid}`);
  await conn.end();
}
main().catch(e => { console.error('auth-diag failed:', e.message); process.exit(1); });
