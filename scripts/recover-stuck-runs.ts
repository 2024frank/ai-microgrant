/**
 * Mark agent_runs that have been stuck in 'running' for too long as 'failed'.
 * Real runs finish in well under 30 min; anything older was almost certainly
 * killed mid-run (the serverless long-poll timeout). Recovering them unblocks
 * the source and cleans up the run history.
 *
 *   npx tsx scripts/recover-stuck-runs.ts          # default: >2 hours
 *   npx tsx scripts/recover-stuck-runs.ts 6        # >6 hours
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

const HOURS = parseInt(process.argv[2] || '2', 10);

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [stuck] = await conn.query(
    `SELECT ar.id, ar.source_id, s.name, ar.started_at
     FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
     WHERE ar.status = 'running' AND ar.started_at < NOW() - INTERVAL ? HOUR
     ORDER BY ar.started_at`,
    [HOURS]
  ) as any;

  if (!(stuck as any[]).length) {
    console.log(`No runs stuck in 'running' for more than ${HOURS}h.`);
    await conn.end();
    return;
  }

  console.log(`Runs stuck in 'running' for more than ${HOURS}h:`);
  for (const r of stuck as any[]) {
    console.log(`  run #${r.id}  ${r.name} (source ${r.source_id})  started ${r.started_at}`);
  }

  const [res] = await conn.query(
    `UPDATE agent_runs
       SET status = 'failed', finished_at = NOW(),
           error_log = JSON_ARRAY('Recovered: stuck in running — likely killed mid-run (serverless timeout)')
     WHERE status = 'running' AND started_at < NOW() - INTERVAL ? HOUR`,
    [HOURS]
  ) as any;

  console.log(`\nMarked ${res.affectedRows} run(s) as failed.`);
  await conn.end();
}

main().catch(e => { console.error('recover failed:', e.message); process.exit(1); });
