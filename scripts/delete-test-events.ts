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
  // Delete test events and their run record
  const [r1] = await conn.query(`DELETE FROM raw_events WHERE title = 'Test Event' AND source_id = 16`) as any;
  const [r2] = await conn.query(`DELETE FROM agent_runs WHERE id = 350`) as any;
  console.log(`Deleted ${r1.affectedRows} raw_events, ${r2.affectedRows} agent_runs`);
  await conn.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
