/** Real production test: run the live Apollo agent end-to-end (feed → posters →
 *  POST). Creates PENDING events in the review queue (nothing reaches
 *  CommunityHub until a reviewer approves). npx tsx scripts/trigger-apollo.ts
 *
 *  NB: pool/agentRunner are imported dynamically AFTER dotenv.config so the DB
 *  pool is built with the loaded env (static imports are hoisted before it). */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

async function main() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  const envId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID || '';
  console.log('ANTHROPIC_API_KEY:', key ? 'set' : 'MISSING');
  console.log('SOURCE_BUILDER_ENVIRONMENT_ID:', envId ? `set (${envId.slice(0, 10)}…)` : 'MISSING');
  if (!key || !envId) { console.error('\nMissing env — cannot trigger the managed-agent session.'); process.exit(2); }

  const { default: pool } = await import('../src/lib/db');
  const { triggerAgentRun } = await import('../src/lib/agentRunner');

  const [res] = await pool.query("INSERT INTO agent_runs (source_id, status) VALUES (3, 'running')") as any;
  const runId = res.insertId;
  console.log(`\nCreated run #${runId} — triggering the Apollo agent (feed → posters → POST). This can take a few minutes…\n`);

  const result = await triggerAgentRun(3, runId, key, envId);
  console.log('\nrun result:', JSON.stringify(result));

  const [[run]] = await pool.query('SELECT status, error_log FROM agent_runs WHERE id = ?', [runId]) as any;
  console.log('run status:', run?.status, run?.error_log ? `error: ${run.error_log}` : '');
  process.exit(0);
}

main().catch(e => {
  console.error('FAILED message:', JSON.stringify(e?.message));
  console.error('detail        :', JSON.stringify(e?.error ?? e?.response?.data ?? '').slice(0, 500));
  console.error('stack         :', String(e?.stack).split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
