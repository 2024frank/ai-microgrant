/**
 * Backfill existing raw_events.ingested_post_url deep-links from the old public
 * /events/{id} page to the reviewer detail page /reviewer/events/{id}, so every
 * event's deep-link opens the reviewer view (Edit + Send-to-CommunityHub)
 * regardless of state — matching what new ingests now write
 * (see lib/agentRunner.ts and api/ingest/[slug]/route.ts).
 *
 * Idempotent: only touches rows still on /events/{id}; skips already-migrated
 * /reviewer/events/{id} rows. The column is the editor deep-link, so approved
 * rows already posted to CommunityHub are updated too (no CH content changes).
 *
 *   npx tsx scripts/backfill-deeplinks.ts            # dry run (counts + samples)
 *   npx tsx scripts/backfill-deeplinks.ts --apply    # actually update
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');

// /events/{id} -> /reviewer/events/{id}, anchored to the numeric id segment so
// nothing else in the URL (host, query) is touched. No-op if already migrated.
const toReviewer = (url: string) => url.replace(/\/events\/(\d+)/, '/reviewer/events/$1');

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    `SELECT id, ingested_post_url FROM raw_events
     WHERE ingested_post_url LIKE '%/events/%'
       AND ingested_post_url NOT LIKE '%/reviewer/events/%'
     ORDER BY id`
  ) as any;

  const targets = (rows as any[])
    .map(r => ({ id: r.id, from: r.ingested_post_url, to: toReviewer(r.ingested_post_url) }))
    .filter(r => r.to !== r.from);

  console.log(`Legacy /events/{id} deep-links to migrate: ${targets.length}\n`);
  for (const r of targets.slice(0, 40)) console.log(`  #${r.id}  ${r.from}  ->  ${r.to}`);
  if (targets.length > 40) console.log(`  ... and ${targets.length - 40} more`);

  if (!APPLY) { console.log('\nDry run — re-run with --apply to update.'); await conn.end(); return; }

  let updated = 0;
  for (const r of targets) {
    const [res] = await conn.query(
      'UPDATE raw_events SET ingested_post_url = ? WHERE id = ?', [r.to, r.id]
    ) as any;
    updated += res.affectedRows;
  }
  console.log(`\nUpdated ${updated} deep-links to /reviewer/events/{id}.`);
  await conn.end();
}

main().catch(e => { console.error('backfill failed:', e.message); process.exit(1); });
