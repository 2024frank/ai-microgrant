/**
 * Registers the email-calendar source in the DB.
 * Safe to run multiple times — skips if already exists.
 *
 * Usage: npx tsx scripts/register-email-source.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  const [[existing]] = await conn.query(
    'SELECT id FROM sources WHERE slug = ?', ['email-calendar']
  ) as any;

  if (existing) {
    console.log('Source already exists: id =', existing.id);
    await conn.end();
    return;
  }

  const [res] = await conn.query(`
    INSERT INTO sources (name, slug, agent_id, source_type, calendar_source_name, schedule_cron, active)
    VALUES (?, 'email-calendar', '', 'email', 'Email Calendar', '0 8 * * *', 1)
  `, ['Email Calendar']) as any;

  console.log('✓ Created source id =', res.insertId);
  console.log('  Runs daily at 8am ET (0 8 * * *)');
  console.log('  Reads unread emails from', process.env.SMTP_USER);
  await conn.end();
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
