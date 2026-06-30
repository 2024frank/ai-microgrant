/** Trigger one source by id (real production run → PENDING events).
 *  npx tsx scripts/trigger-source.ts <sourceId>
 *  Dynamic imports AFTER dotenv so the DB pool gets the loaded env. */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

async function main() {
  const sourceId = parseInt(process.argv[2] || '9');
  const key = process.env.ANTHROPIC_API_KEY || '';
  const envId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID || '';
  if (!key || !envId) { console.error('Missing ANTHROPIC_API_KEY / SOURCE_BUILDER_ENVIRONMENT_ID'); process.exit(2); }

  const { default: pool } = await import('../src/lib/db');
  const { triggerAgentRun } = await import('../src/lib/agentRunner');

  const [[src]] = await pool.query('SELECT id, name FROM sources WHERE id = ?', [sourceId]) as any;
  if (!src) { console.error('source not found:', sourceId); process.exit(1); }
  const [res] = await pool.query("INSERT INTO agent_runs (source_id, status) VALUES (?, 'running')", [sourceId]) as any;
  const runId = res.insertId;
  console.log(`#${sourceId} ${src.name} → run ${runId}, triggering (can take a few minutes)…`);

  const r = await triggerAgentRun(sourceId, runId, key, envId);
  console.log('result:', JSON.stringify(r));
  const [[run]] = await pool.query('SELECT status FROM agent_runs WHERE id = ?', [runId]) as any;
  console.log('run status:', run?.status);
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e?.message); process.exit(1); });
