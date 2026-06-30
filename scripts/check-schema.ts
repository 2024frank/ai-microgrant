/** Read-only: reconcile migration tracking with the real prod schema. */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  const q = async (sql: string) => { const [r] = await c.query(sql) as any; return r as any[]; };
  const has = async (sql: string) => (await q(sql)).length > 0;

  console.log('schema_migrations recorded:', (await q('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version).join(', ') || '(none)');
  console.log('0003 idx_run_source_started:', await has("SHOW INDEX FROM agent_runs WHERE Key_name='idx_run_source_started'") ? 'EXISTS' : 'missing');
  console.log('0004 raw_events.dedup_key   :', await has("SHOW COLUMNS FROM raw_events LIKE 'dedup_key'") ? 'EXISTS' : 'missing');
  console.log('0005 agent_runs.session_id  :', await has("SHOW COLUMNS FROM agent_runs LIKE 'session_id'") ? 'EXISTS' : 'missing');
  console.log('0006 apollo_film_runs table :', await has("SHOW TABLES LIKE 'apollo_film_runs'") ? 'EXISTS' : 'missing');
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
