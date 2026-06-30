/**
 * Audit or switch the Claude model on every source's Anthropic managed agent.
 *
 * The model lives on the agent object (server-side, in the Anthropic account) —
 * NOT in this repo. agentRunner creates a session referencing the agent by id and
 * uses its latest version, so updating the agent's model takes effect on the next
 * run automatically. Each update creates a new agent version (optimistic-locked on
 * the current version), so this is reversible — re-run with the old model id.
 *
 *   npx tsx scripts/set-agent-model.ts                               # audit: print each agent's current model
 *   npx tsx scripts/set-agent-model.ts --apply claude-sonnet-4-6     # switch every active source's agent
 *   npx tsx scripts/set-agent-model.ts --apply claude-opus-4-8 --all # include inactive sources too
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';
import Anthropic from '@anthropic-ai/sdk';

const applyIdx = process.argv.indexOf('--apply');
const TARGET_MODEL = applyIdx >= 0 ? process.argv[applyIdx + 1] : null;
const INCLUDE_INACTIVE = process.argv.includes('--all');

// agent.model may be a bare string or a { id, speed } object — normalize to the id.
const modelId = (m: any) => (typeof m === 'string' ? m : m?.id ?? JSON.stringify(m));

async function main() {
  if (applyIdx >= 0 && (!TARGET_MODEL || TARGET_MODEL.startsWith('--'))) {
    console.error('Usage: --apply <model-id>   e.g. --apply claude-sonnet-4-6');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    `SELECT id, name, slug, agent_id, active FROM sources
     ${INCLUDE_INACTIVE ? '' : 'WHERE active = 1'} ORDER BY id`
  ) as any;
  await conn.end();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const mode = TARGET_MODEL ? `switching to ${TARGET_MODEL}` : 'audit (read-only)';
  console.log(`\n${(rows as any[]).length} source(s)${INCLUDE_INACTIVE ? '' : ' (active only — pass --all for inactive)'} — ${mode}:\n`);

  for (const s of rows as any[]) {
    if (!s.agent_id) { console.log(`  #${s.id} ${s.name}: NO agent_id — skipped`); continue; }
    try {
      const a = await (client.beta.agents as any).retrieve(s.agent_id);
      const cur = modelId(a.model);
      if (!TARGET_MODEL) {
        console.log(`  #${s.id} ${s.name}: ${cur}  (v${a.version})`);
        continue;
      }
      if (cur === TARGET_MODEL) {
        console.log(`  #${s.id} ${s.name}: already ${TARGET_MODEL} — skipped`);
        continue;
      }
      const updated = await (client.beta.agents as any).update(s.agent_id, {
        model:   TARGET_MODEL,
        version: a.version,
      });
      console.log(`  #${s.id} ${s.name}: ${cur} -> ${TARGET_MODEL}  (now v${updated.version})`);
    } catch (e: any) {
      console.log(`  #${s.id} ${s.name}: ERROR — ${String(e.message).slice(0, 80)}`);
    }
  }
}

main().catch(e => { console.error('set-agent-model failed:', e.message); process.exit(1); });
