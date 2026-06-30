/**
 * Set a source's cron schedule by slug. Prints before/after.
 *
 *   npx tsx scripts/set-schedule.ts fava "0 6 * * 1"     # FAVA → Mondays
 *
 * The daily trigger only honours the cron's date fields (see lib/schedule.ts),
 * so "0 6 * * 1" = weekly on Mondays, "0 6 * * *" = daily.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const slug = process.argv[2];
const cron = process.argv[3];

async function main() {
  if (!slug || !cron) {
    console.error('usage: tsx scripts/set-schedule.ts <slug> "<cron>"');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [[before]] = await conn.query(
    'SELECT id, name, schedule_cron FROM sources WHERE slug = ?', [slug]
  ) as any;
  if (!before) { console.error(`No source with slug "${slug}".`); await conn.end(); process.exit(1); }

  console.log(`before: #${before.id} ${before.name}  schedule_cron = ${before.schedule_cron}`);
  await conn.query('UPDATE sources SET schedule_cron = ? WHERE slug = ?', [cron, slug]);
  const [[after]] = await conn.query(
    'SELECT schedule_cron FROM sources WHERE slug = ?', [slug]
  ) as any;
  console.log(`after:  #${before.id} ${before.name}  schedule_cron = ${after.schedule_cron}`);

  await conn.end();
}

main().catch(e => { console.error('set-schedule failed:', e.message); process.exit(1); });
