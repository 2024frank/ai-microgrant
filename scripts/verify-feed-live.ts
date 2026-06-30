/** Verify the deployed Apollo feed using the secret embedded in the LIVE agent
 *  prompt (the one that already works against the ingest endpoint). Read-only. */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';

(async () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const agent = await (client.beta.agents as any).retrieve(process.env.APOLLO_AGENT_ID || 'agent_011JUMEmkFKkyJRckbWongao');
  const sys: string = agent.system ?? agent.system_prompt ?? '';
  const secret = (sys.match(/x-ingest-secret:\s*([^\s]+)/) || [])[1];
  const token = (sys.match(/siteToken=([A-Za-z0-9_-]+)/) || [])[1];
  console.log('live prompt secret:', secret ? `found (len ${secret.length})` : 'NOT FOUND');
  console.log('live prompt token :', token ? `found (len ${token.length})` : 'NOT FOUND');
  console.log('local INGEST_SECRET matches live prompt:', (process.env.INGEST_SECRET || '') === secret);

  const url = 'https://ai-microgrant-research-oberlin.vercel.app/api/sources/apollo/feed';
  const res = await fetch(url, { headers: { 'x-ingest-secret': secret || '' } });
  console.log('\nfeed HTTP', res.status);
  const j: any = await res.json().catch(() => null);
  if (j?.events) {
    console.log(`events: ${j.events.length}  filmsSeen: ${(j.filmsSeen || []).length}`);
    for (const e of j.events) console.log(`   ${e.title} :: ${e.description}`);
  } else {
    console.log('body:', JSON.stringify(j).slice(0, 400));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
