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

  const ALL_NEW = [11, 12, 13, 14, 15, 16, 17];

  const [runs] = await conn.query(`
    SELECT ar.id, s.name, ar.status, ar.events_found, ar.events_extracted, ar.started_at
    FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
    WHERE ar.source_id IN (${ALL_NEW.join(',')}) AND ar.events_found > 0
    ORDER BY ar.id DESC LIMIT 20
  `) as any;
  console.log(`=== Successful runs (events_found > 0) ===`);
  for (const r of runs) {
    console.log(`  run=${r.id} [${r.name}] found=${r.events_found} extracted=${r.events_extracted}`);
  }

  const [events] = await conn.query(`
    SELECT re.id, s.name, re.title, re.status, re.description
    FROM raw_events re JOIN sources s ON s.id = re.source_id
    WHERE re.source_id IN (${ALL_NEW.join(',')}) AND re.status = 'pending'
    ORDER BY s.id, re.id
  `) as any;
  console.log(`\n=== All pending events from new sources (${events.length} total) ===`);
  for (const e of events) {
    console.log(`  [${e.name}] #${e.id}: "${e.title}"`);
    console.log(`         ${e.description?.slice(0, 100)}`);
  }

  await conn.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
