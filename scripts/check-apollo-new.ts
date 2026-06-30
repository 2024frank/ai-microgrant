import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  const [rows] = await c.query(
    `SELECT id, status, title, LEFT(description,95) AS description,
       (image_data IS NOT NULL OR image_cdn_url IS NOT NULL) AS has_image, ingested_post_url, created_at
     FROM raw_events WHERE source_id=3 AND created_at > (NOW() - INTERVAL 30 MINUTE) ORDER BY id DESC`) as any;
  console.log(`New Apollo events (last 30 min): ${(rows as any[]).length}\n`);
  for (const r of rows as any[]) {
    console.log(`#${r.id} [${r.status}] poster=${r.has_image ? 'YES' : 'no '} "${r.title}"`);
    console.log(`   ${r.description}`);
    console.log(`   ${r.ingested_post_url}\n`);
  }
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
