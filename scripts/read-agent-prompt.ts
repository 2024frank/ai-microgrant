import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';

const agentId = process.argv[2];
if (!agentId) { console.error('usage: npx tsx scripts/read-agent-prompt.ts <agent_id>'); process.exit(1); }

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const agent = await (client.beta.agents as any).retrieve(agentId);
  console.log('Name:', agent.name);
  console.log('Version:', agent.version);
  console.log('\n=== SYSTEM PROMPT ===\n');
  console.log(agent.system);
}
main().catch(e => { console.error(e.message); process.exit(1); });
