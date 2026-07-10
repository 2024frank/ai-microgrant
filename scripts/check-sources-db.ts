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

  const [rows] = await conn.query(
    `SELECT id, name, slug, source_type, active FROM sources ORDER BY id`
  ) as any;
  console.log('=== All sources ===');
  for (const r of rows) {
    console.log(`  id=${r.id} slug=${r.slug} active=${r.active} type=${r.source_type} name=${r.name}`);
  }
  await conn.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
