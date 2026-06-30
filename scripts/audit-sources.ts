/**
 * Read-only audit of every source's configuration:
 *   - slug, schedule, active flag
 *   - whether its Anthropic agent_id actually resolves
 *   - last agent run status
 *
 * Usage: npx tsx scripts/audit-sources.ts
 * Only reads (SELECT + agents.retrieve) — never modifies anything.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';
import Anthropic from '@anthropic-ai/sdk';

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    `SELECT s.id, s.name, s.slug, s.agent_id, s.schedule_cron, s.active,
       (SELECT ar.status     FROM agent_runs ar WHERE ar.source_id = s.id ORDER BY ar.started_at DESC LIMIT 1) AS last_status,
       (SELECT ar.started_at FROM agent_runs ar WHERE ar.source_id = s.id ORDER BY ar.started_at DESC LIMIT 1) AS last_run
     FROM sources s ORDER BY s.id`
  ) as any;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`\n${(rows as any[]).length} source(s):\n`);
  for (const s of rows as any[]) {
    let agentState: string;
    if (!s.agent_id) {
      agentState = 'NO agent_id';
    } else {
      try {
        const a = await (client.beta.agents as any).retrieve(s.agent_id);
        agentState = `OK — ${a.name} (v${a.version})`;
      } catch (e: any) {
        agentState = `UNRESOLVED — ${String(e.message).slice(0, 60)}`;
      }
    }
    console.log(`[${s.active ? 'active' : ' off  '}] #${s.id}  ${s.name}  (slug=${s.slug})`);
    console.log(`         schedule=${s.schedule_cron}   agent=${agentState}`);
    console.log(`         last run: ${s.last_status ?? 'never'} ${s.last_run ? '@ ' + s.last_run : ''}\n`);
  }

  await conn.end();
}

main().catch(e => { console.error('audit failed:', e.message); process.exit(1); });
