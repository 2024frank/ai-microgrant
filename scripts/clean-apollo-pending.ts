/**
 * Remove the old, wrongly-extracted Apollo announcements that are still pending
 * (never posted to CommunityHub) — the daily-duplicate / silly-range events from
 * the old LLM extraction. Approved/posted rows are left untouched (deleting them
 * locally would not un-post them from CommunityHub).
 *
 *   npx tsx scripts/clean-apollo-pending.ts            # dry run
 *   npx tsx scripts/clean-apollo-pending.ts --apply    # delete
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    `SELECT id, status, title, LEFT(description, 70) AS description, created_at
     FROM raw_events
     WHERE source_id = 3 AND status IN ('pending', 'pending_fix')
     ORDER BY id`
  ) as any;

  console.log(`Apollo pending/pending_fix rows to remove: ${(rows as any[]).length}\n`);
  for (const r of rows as any[]) console.log(`  #${r.id} [${r.status}] ${r.title}: ${r.description}`);

  // Show what is kept, for transparency.
  const [[kept]] = await conn.query(
    "SELECT COUNT(*) AS n FROM raw_events WHERE source_id = 3 AND status NOT IN ('pending','pending_fix')"
  ) as any;
  console.log(`\nKeeping ${kept.n} approved/rejected Apollo rows (already posted or decided).`);

  if (!APPLY) { console.log('\nDry run — re-run with --apply to delete.'); await conn.end(); return; }

  const ids = (rows as any[]).map(r => r.id);
  if (ids.length) {
    const [res] = await conn.query(`DELETE FROM raw_events WHERE id IN (${ids.map(() => '?').join(',')})`, ids) as any;
    console.log(`\nDeleted ${res.affectedRows} rows.`);
  } else {
    console.log('\nNothing to delete.');
  }
  await conn.end();
}

main().catch(e => { console.error('clean failed:', e.message); process.exit(1); });
