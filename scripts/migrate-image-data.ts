/**
 * Migration: move base64 image data from image_cdn_url → image_data,
 * set image_cdn_url to the public serving URL, then patch CommunityHub
 * for already-approved events so their images appear.
 *
 * Run AFTER deploying the new /api/events/[id]/image endpoint.
 * Usage: npx tsx scripts/migrate-image-data.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';
const CH_BASE  = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
    // base64 values can be large — increase packet size
    multipleStatements: false,
  });

  // Step 1: Add image_data column if it doesn't exist yet
  console.log('Checking schema...');
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_events' AND COLUMN_NAME = 'image_data'`
  ) as any;
  if ((cols as any[]).length === 0) {
    console.log('Adding image_data column...');
    await conn.query(
      `ALTER TABLE raw_events ADD COLUMN image_data MEDIUMTEXT NULL AFTER image_cdn_url`
    );
    console.log('✓ Column added');
  } else {
    console.log('✓ image_data column already exists');
  }

  // Step 2: Find all events with base64 in image_cdn_url
  const [rows] = await conn.query(
    `SELECT id, image_cdn_url, communityhub_post_id, status
     FROM raw_events
     WHERE image_cdn_url LIKE 'data:%' AND image_data IS NULL`
  ) as any;

  console.log(`\nFound ${(rows as any[]).length} events with base64 images to migrate`);

  let migrated = 0;
  let chPatched = 0;
  let chFailed  = 0;

  for (const row of rows as any[]) {
    const { id, image_cdn_url, communityhub_post_id } = row;
    const imageUrl = `${APP_URL}/api/events/${id}/image`;

    // Move base64 to image_data, set image_cdn_url to the serving URL
    await conn.query(
      `UPDATE raw_events SET image_data = image_cdn_url, image_cdn_url = ? WHERE id = ?`,
      [imageUrl, id]
    );
    migrated++;

    // Patch CommunityHub if this event was already approved
    if (communityhub_post_id) {
      try {
        const res = await fetch(`${CH_BASE}/post/${communityhub_post_id}/submit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageCdnUrl: imageUrl }),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        if (res.ok) {
          chPatched++;
          console.log(`  ✓ event ${id} → patched CommunityHub post ${communityhub_post_id}`);
        } else {
          chFailed++;
          console.warn(`  ✗ event ${id} → CH PATCH failed ${res.status}: ${text.slice(0, 100)}`);
        }
      } catch (err: any) {
        chFailed++;
        console.warn(`  ✗ event ${id} → CH PATCH error: ${err.message}`);
      }
    } else {
      console.log(`  · event ${id} migrated (not yet submitted to CommunityHub)`);
    }
  }

  await conn.end();

  console.log(`\nDone.`);
  console.log(`  DB rows migrated:      ${migrated}`);
  console.log(`  CommunityHub patched:  ${chPatched}`);
  console.log(`  CommunityHub failed:   ${chFailed}`);
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
