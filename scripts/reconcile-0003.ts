/** Mark 0003 as applied only if all 6 of its indexes already exist (the prod DB
 *  predates migration tracking). Then `npm run db:migrate` applies 0004–0006.
 *    npx tsx scripts/reconcile-0003.ts            # check
 *    npx tsx scripts/reconcile-0003.ts --apply    # record 0003 as applied
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const WANT: Record<string, string[]> = {
  raw_events: ['idx_raw_status_created', 'idx_raw_source_status_created', 'idx_raw_corrected_status', 'idx_raw_calsrcurl'],
  review_sessions: ['idx_rsess_reviewer_action'],
  agent_runs: ['idx_run_source_started'],
};

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  let allExist = true;
  for (const [table, names] of Object.entries(WANT)) {
    const [rows] = await c.query(`SHOW INDEX FROM ${table}`) as any;
    const present = new Set((rows as any[]).map(r => r.Key_name));
    for (const n of names) { const ok = present.has(n); console.log(`${ok ? '✓' : '✗'} ${table}.${n}`); if (!ok) allExist = false; }
  }
  if (!allExist) { console.log('\n✗ Not all 0003 indexes exist — NOT marking applied. (Make 0003 idempotent and run it instead.)'); await c.end(); return; }
  if (!APPLY) { console.log('\nAll 6 indexes exist. Re-run with --apply to record 0003 as applied.'); await c.end(); return; }
  await c.query("INSERT IGNORE INTO schema_migrations (version) VALUES ('0003_performance_indexes.sql')");
  console.log('\n✓ Recorded 0003_performance_indexes.sql as applied. Now run: npm run db:migrate');
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
