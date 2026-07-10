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

  const [rows] = await conn.query(`
    SELECT ar.id, s.name, ar.status, ar.events_found, ar.events_extracted, ar.error_log
    FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
    WHERE ar.source_id IN (13,14,15,16,17)
    ORDER BY ar.id DESC LIMIT 20
  `) as any;

  console.log('=== Agent runs for new sources ===');
  for (const r of rows) {
    const err = r.error_log ? ' ERR: ' + String(r.error_log).slice(0, 200) : '';
    console.log(`run=${r.id} [${r.name}] status=${r.status} found=${r.events_found} extracted=${r.events_extracted}${err}`);
  }

  await conn.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
