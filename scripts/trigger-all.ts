/** Trigger every active source to run now (real production runs → PENDING events
 *  in the review queue). npx tsx scripts/trigger-all.ts
 *  Dynamic imports AFTER dotenv so the DB pool is built with the loaded env. */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

async function main() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  const envId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID || '';
  if (!key || !envId) { console.error('Missing ANTHROPIC_API_KEY / SOURCE_BUILDER_ENVIRONMENT_ID'); process.exit(2); }

  const { default: pool } = await import('../src/lib/db');
  const { triggerAgentRun } = await import('../src/lib/agentRunner');

  const [sources] = await pool.query('SELECT id, name FROM sources WHERE active = 1 ORDER BY id') as any;
  console.log(`Triggering ${(sources as any[]).length} active sources in parallel…\n`);

  const settled = await Promise.allSettled((sources as any[]).map(async (s) => {
    const [res] = await pool.query("INSERT INTO agent_runs (source_id, status) VALUES (?, 'running')", [s.id]) as any;
    const runId = res.insertId;
    console.log(`▶ #${s.id} ${s.name} → run ${runId}`);
    const result = await triggerAgentRun(s.id, runId, key, envId);
    return { id: s.id, name: s.name, result };
  }));

  console.log('\n=== results ===');
  settled.forEach((r, i) => {
    const s = (sources as any[])[i];
    if (r.status === 'fulfilled') console.log(`✓ #${s.id} ${s.name}: ${JSON.stringify(r.value.result)}`);
    else console.log(`✗ #${s.id} ${s.name}: ${r.reason?.message || 'failed'}`);
  });
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e?.message); process.exit(1); });
