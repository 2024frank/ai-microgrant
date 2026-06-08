/**
 * Reads the current Apollo Theatre agent system prompt from the Anthropic API.
 * Usage: npx tsx scripts/read-apollo-prompt.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import Anthropic from '@anthropic-ai/sdk';

const AGENT_ID = 'agent_011JUMEmkFKkyJRckbWongao';

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const agent = await (client.beta.agents as any).retrieve(AGENT_ID);
  console.log('Name:', agent.name);
  console.log('Version:', agent.version);
  console.log('Model:', agent.model);
  console.log('\n=== SYSTEM PROMPT ===\n');
  console.log(agent.system_prompt ?? agent.instructions ?? JSON.stringify(agent, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
