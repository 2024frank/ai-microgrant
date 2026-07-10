/**
 * Triggers a single source and prints full agent output for debugging.
 * Usage: npx tsx scripts/debug-one-source.ts <source_id>
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const sourceId = parseInt(process.argv[2] || '13');
const TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 3000;

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });
  const environmentId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '';

  const [[source]] = await conn.query(
    'SELECT id, name, agent_id FROM sources WHERE id = ?', [sourceId]
  ) as any;
  if (!source) { console.error('Source not found'); process.exit(1); }

  console.log(`Running: ${source.name} (id=${source.id}, agent=${source.agent_id})\n`);

  const session = await (client.beta.sessions as any).create({
    agent: source.agent_id,
    environment_id: environmentId,
  });
  console.log(`Session: ${session.id}\n`);

  await (client.beta.sessions as any).events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: 'Run extraction now. Return only the JSON array of events.' }] }],
  });

  const deadline = Date.now() + TIMEOUT_MS;
  let afterCreatedAt: string | undefined;
  let done = false;
  const outputChunks: string[] = [];

  while (!done) {
    if (Date.now() > deadline) { console.error('Timed out'); break; }

    const page = await (client.beta.sessions as any).events.list(session.id, {
      ...(afterCreatedAt ? { 'created_at[gt]': afterCreatedAt } : {}),
      limit: 100,
      order: 'asc',
    }) as any;

    for (const event of (page.data ?? [])) {
      if (event.created_at) afterCreatedAt = event.created_at;

      // Print all event types so we can see what's happening
      if (event.type !== 'session.status_idle') {
        const contentPreview = JSON.stringify(event.content ?? event).slice(0, 300);
        console.log(`[${event.type}] ${contentPreview}`);
      }

      if (event.type === 'agent.message') {
        for (const block of (event.content ?? []) as any[]) {
          if (block.type === 'text' && block.text) outputChunks.push(block.text);
        }
      }

      if (event.type === 'session.status_idle') {
        const stopReason = event.stop_reason;
        console.log(`\n[session.status_idle] stop_reason: ${JSON.stringify(stopReason)}`);
        if (stopReason?.type !== 'requires_action') {
          done = true;
          break;
        }
      }
    }

    if (!done) await new Promise(r => setTimeout(r, POLL_MS));
  }

  console.log('\n── Agent final output ──');
  console.log(outputChunks.join('') || '(no text output)');

  await conn.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
