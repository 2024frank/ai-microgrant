/**
 * Patches all approved CommunityHub posts that have an image stored in our DB
 * but no image showing on CommunityHub (because we were using wrong field name).
 *
 * Sends the base64 image directly via the correct field: image_cdn_url
 *
 * Usage: npx tsx scripts/patch-ch-images.ts
 * Optional: npx tsx scripts/patch-ch-images.ts <communityhub_post_id>  (single post)
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

async function main() {
  const targetId = process.argv[2] || null;

  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  // Find approved events that have image data and a CommunityHub post ID
  const whereClause = targetId
    ? `AND re.communityhub_post_id = ${conn.escape(targetId)}`
    : '';

  // Check if image_data column exists yet
  const [colCheck] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_events' AND COLUMN_NAME = 'image_data'`
  ) as any;
  const hasImageData = (colCheck as any[])[0].cnt > 0;
  const imageCol = hasImageData ? 'COALESCE(re.image_data, re.image_cdn_url)' : 're.image_cdn_url';

  const [rows] = await conn.query(
    `SELECT re.id, re.communityhub_post_id,
            ${imageCol} AS image_val
     FROM raw_events re
     WHERE re.status IN ('approved', 'resubmitted')
       AND re.communityhub_post_id IS NOT NULL
       AND re.image_cdn_url IS NOT NULL
       ${whereClause}
     ORDER BY re.id`
  ) as any;

  console.log(`Found ${(rows as any[]).length} posts to patch\n`);

  let ok = 0, fail = 0;

  for (const row of rows as any[]) {
    const { id, communityhub_post_id, image_val } = row;
    if (!image_val) continue;

    // image_val may be a data URI (from merged posters) or a plain URL
    const payload: any = { image_cdn_url: image_val };

    try {
      const res = await fetch(`${CH_BASE}/post/${communityhub_post_id}/submit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (res.ok) {
        ok++;
        console.log(`✓ event ${id} → CH post ${communityhub_post_id}`);
      } else {
        fail++;
        console.warn(`✗ event ${id} → ${res.status}: ${text.slice(0, 120)}`);
      }
    } catch (err: any) {
      fail++;
      console.warn(`✗ event ${id} → ${err.message}`);
    }
  }

  await conn.end();
  console.log(`\nDone. ✓ ${ok} patched, ✗ ${fail} failed`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
