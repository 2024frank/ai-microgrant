/**
 * Updates the 5 new source agents from claude-sonnet-5 → claude-sonnet-4-6
 * (the environment is configured for 4-6; sonnet-5 tries to delegate via create_agent instead of browsing)
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const SOURCE_IDS = [13, 14, 15, 16, 17];

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  const [sources] = await conn.query(
    `SELECT id, name, agent_id FROM sources WHERE id IN (${SOURCE_IDS.join(',')}) ORDER BY id`
  ) as any;

  for (const src of sources) {
    console.log(`Updating ${src.name} (agent=${src.agent_id}) → claude-sonnet-4-6...`);
    // Retrieve current version first — the update API requires it
    const current = await (client.beta.agents as any).retrieve(src.agent_id);
    console.log(`  current model=${current.model} version=${current.version}`);
    await (client.beta.agents as any).update(src.agent_id, {
      version: current.version,
      model: 'claude-sonnet-4-6',
    });
    console.log(`  ✓ updated`);
  }

  await conn.end();
  console.log('\nAll agents updated. Re-run trigger-new-sources.ts to test.');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
