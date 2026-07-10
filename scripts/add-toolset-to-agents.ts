/**
 * Adds the agent_toolset_20260401 (web browsing + HTTP + computer use) to all
 * new agents that were created without tools.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const TOOLSET = {
  type: 'agent_toolset_20260401',
  configs: [],
  default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
};

const NEW_SOURCE_IDS = [11, 12, 13, 15, 16];

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  const [sources] = await conn.query(
    `SELECT id, name, agent_id FROM sources WHERE id IN (${NEW_SOURCE_IDS.join(',')}) ORDER BY id`
  ) as any;

  for (const src of sources) {
    if (!src.agent_id) { console.log(`  ${src.name}: no agent_id, skipping`); continue; }

    const current = await (client.beta.agents as any).retrieve(src.agent_id);
    const hasToolset = (current.tools ?? []).some((t: any) => t.type === 'agent_toolset_20260401');

    if (hasToolset) {
      console.log(`  ${src.name}: already has toolset, skipping`);
      continue;
    }

    console.log(`Updating ${src.name} (agent=${src.agent_id}) — adding toolset...`);
    await (client.beta.agents as any).update(src.agent_id, {
      version: current.version,
      tools: [TOOLSET],
    });
    console.log(`  ✓ toolset added (now v${current.version + 1})`);
  }

  await conn.end();
  console.log('\nDone. Re-run trigger-new-sources.ts to test.');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
