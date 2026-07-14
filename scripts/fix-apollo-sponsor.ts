/**
 * Replaces the "Cleveland Cinemas" sponsor with "Apollo Theatre" on every
 * Apollo Theater event: updates the raw_events rows so future edits and
 * resubmits carry the right sponsor, and PATCHes any post already published
 * to CommunityHub so the live calendar matches.
 *
 * Usage: npx tsx scripts/fix-apollo-sponsor.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';
const OLD_SPONSOR = 'Cleveland Cinemas';
const NEW_SPONSOR = 'Apollo Theatre';

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
    `SELECT id, status, sponsors, communityhub_post_id
     FROM raw_events
     WHERE sponsors LIKE ?
     ORDER BY id`,
    [`%${OLD_SPONSOR}%`]
  ) as any;

  console.log(`Found ${(rows as any[]).length} events sponsored by "${OLD_SPONSOR}"\n`);

  let patched = 0, failed = 0;

  for (const row of rows as any[]) {
    const sponsors: string[] = typeof row.sponsors === 'string' ? JSON.parse(row.sponsors) : row.sponsors;
    const updated = [...new Set(sponsors.map(s => (s === OLD_SPONSOR ? NEW_SPONSOR : s)))];

    await conn.query('UPDATE raw_events SET sponsors = ? WHERE id = ?', [JSON.stringify(updated), row.id]);
    console.log(`✓ event ${row.id} [${row.status}] sponsors → ${JSON.stringify(updated)}`);

    // Expired posts are removed from CommunityHub, so a 404 here is expected.
    if (!row.communityhub_post_id || !['approved', 'resubmitted'].includes(row.status)) continue;
    try {
      const res = await fetch(`${CH_BASE}/post/${row.communityhub_post_id}/submit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sponsors: updated }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (res.ok) {
        patched++;
        console.log(`  ✓ CH post ${row.communityhub_post_id} patched`);
      } else {
        failed++;
        console.warn(`  ✗ CH post ${row.communityhub_post_id} → ${res.status}: ${text.slice(0, 120)}`);
      }
    } catch (err: any) {
      failed++;
      console.warn(`  ✗ CH post ${row.communityhub_post_id} → ${err.message}`);
    }
  }

  await conn.end();
  console.log(`\nDone. CommunityHub: ✓ ${patched} patched, ✗ ${failed} failed`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
