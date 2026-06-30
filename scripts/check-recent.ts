import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  const [runs] = await c.query("SELECT id, source_id, status, LEFT(error_log,55) err FROM agent_runs WHERE id BETWEEN 260 AND 265 ORDER BY id") as any;
  console.log('=== runs 260–265 ===');
  for (const r of runs as any[]) console.log(`  run ${r.id} src=${r.source_id} ${r.status} ${r.err || ''}`);
  const [ev] = await c.query(
    `SELECT s.name, re.status, COUNT(*) n, MAX(re.created_at) latest
     FROM raw_events re JOIN sources s ON s.id=re.source_id
     WHERE re.created_at > (NOW() - INTERVAL 20 MINUTE)
     GROUP BY s.name, re.status ORDER BY latest DESC`) as any;
  console.log('\n=== events posted in last 20 min ===');
  if (!(ev as any[]).length) console.log('  (none yet — scraping agents may still be running)');
  for (const r of ev as any[]) console.log(`  ${r.name} [${r.status}]: ${r.n}  (latest ${r.latest})`);
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
