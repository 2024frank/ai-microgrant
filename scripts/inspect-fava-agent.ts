/**
 * Inspects the FAVA agent prompt to understand the system prompt structure that works
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  // Get all sources with their agent_ids
  const [sources] = await conn.query(
    `SELECT id, name, slug, agent_id FROM sources WHERE source_type = 'web' ORDER BY id`
  ) as any;

  console.log('=== All web sources ===');
  for (const s of sources) {
    console.log(`  id=${s.id} slug=${s.slug} agent=${s.agent_id}`);
  }

  // Check recent successful runs from working sources (id 3-9)
  console.log('\n=== Recent successful runs from working sources ===');
  const [runs] = await conn.query(`
    SELECT ar.id, s.name, ar.status, ar.events_found, ar.events_extracted, ar.started_at
    FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
    WHERE ar.source_id IN (3,4,6,7,8,9) AND ar.status = 'completed' AND ar.events_found > 0
    ORDER BY ar.id DESC LIMIT 10
  `) as any;
  for (const r of runs) {
    console.log(`  run=${r.id} [${r.name}] found=${r.events_found} extracted=${r.events_extracted}`);
  }

  // Check recent runs for new sources (13-17)
  console.log('\n=== All runs for new sources ===');
  const [newRuns] = await conn.query(`
    SELECT ar.id, s.name, ar.status, ar.events_found, ar.events_extracted
    FROM agent_runs ar JOIN sources s ON s.id = ar.source_id
    WHERE ar.source_id IN (13,14,15,16,17)
    ORDER BY ar.id DESC LIMIT 30
  `) as any;
  for (const r of newRuns) {
    console.log(`  run=${r.id} [${r.name}] status=${r.status} found=${r.events_found} extracted=${r.events_extracted}`);
  }

  // Fetch FAVA agent system prompt (first 2000 chars)
  console.log('\n=== FAVA agent system prompt (first 2000 chars) ===');
  const fava = await (client.beta.agents as any).retrieve('agent_01GiCvrVVtE8fjNjnbZdCBsE');
  console.log(String(fava.system ?? '').slice(0, 2000));

  await conn.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
