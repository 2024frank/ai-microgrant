/** Print a source's current Anthropic agent prompt. npx tsx scripts/read-source-prompt.ts <id|slug> */
import * as dotenv from 'dotenv';
const _w = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = () => true;
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
(process.stdout as any).write = _w;
import mysql from 'mysql2/promise';
import Anthropic from '@anthropic-ai/sdk';

(async () => {
  const arg = process.argv[2] || 'fava';
  const c = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  const [[src]] = await c.query('SELECT id, name, slug, agent_id FROM sources WHERE slug = ? OR id = ?', [arg, arg]) as any;
  await c.end();
  if (!src) { console.error('source not found:', arg); process.exit(1); }
  console.log(`#${src.id} ${src.name}  slug=${src.slug}  agent=${src.agent_id}`);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const agent = await (client.beta.agents as any).retrieve(src.agent_id);
  console.log(`model=${typeof agent.model === 'string' ? agent.model : agent.model?.id}  version=${agent.version}`);
  console.log('\n=== SYSTEM PROMPT ===\n');
  console.log(agent.system ?? agent.system_prompt ?? '(none)');
})().catch(e => { console.error(e.message); process.exit(1); });
