/**
 * Patches approved CommunityHub posts that have image_data in our DB but
 * no image on CommunityHub. Sends the serving URL (/api/events/{id}/poster.jpg)
 * which has a .jpg extension that CommunityHub accepts.
 *
 * Usage: npx tsx scripts/patch-ch-images.ts
 * Optional: npx tsx scripts/patch-ch-images.ts <communityhub_post_id>  (single post)
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const CH_BASE = 'https://oberlin.communityhub.cloud/api/legacy/calendar';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

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

  const whereClause = targetId
    ? `AND re.communityhub_post_id = ${conn.escape(targetId)}`
    : '';

  // Find approved events that have image_data (base64) stored but no serving URL set
  const [rows] = await conn.query(
    `SELECT re.id, re.communityhub_post_id
     FROM raw_events re
     WHERE re.status IN ('approved', 'resubmitted')
       AND re.communityhub_post_id IS NOT NULL
       AND re.image_data IS NOT NULL
       ${whereClause}
     ORDER BY re.id`
  ) as any;

  console.log(`Found ${(rows as any[]).length} posts to patch\n`);

  let ok = 0, fail = 0;

  for (const row of rows as any[]) {
    const { id, communityhub_post_id } = row;

    // Build serving URL with .jpg extension — CH validates file extension in the URL
    const imageUrl = `${APP_URL}/api/events/${id}/poster.jpg`;

    // Update DB so future approvals also use the correct serving URL
    await conn.query('UPDATE raw_events SET image_cdn_url = ? WHERE id = ?', [imageUrl, id]);

    const payload: any = { image_cdn_url: imageUrl };

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
