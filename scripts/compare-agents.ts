import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const agentIds = [
    { name: 'FAVA (working)',       id: 'agent_01GiCvrVVtE8fjNjnbZdCBsE' },
    { name: 'Apollo (working)',     id: 'agent_011JUMEmkFKkyJRckbWongao' },
    { name: 'AMAM (new/broken)',    id: 'agent_013KEaHtT2mswfzG5XQ3mS6Q' },
    { name: 'First Church (new)',   id: 'agent_015hovoHNXLUhfYp6GhGwmtQ' },
  ];

  for (const a of agentIds) {
    const agent = await (client.beta.agents as any).retrieve(a.id);
    console.log(`\n=== ${a.name} (${a.id}) ===`);
    console.log('  model:      ', JSON.stringify(agent.model));
    console.log('  version:    ', agent.version);
    console.log('  tools:      ', JSON.stringify(agent.tools));
    console.log('  skills:     ', JSON.stringify(agent.skills));
    console.log('  mcp_servers:', JSON.stringify(agent.mcp_servers));
    console.log('  multiagent: ', JSON.stringify(agent.multiagent));
    console.log('  type:       ', agent.type);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
