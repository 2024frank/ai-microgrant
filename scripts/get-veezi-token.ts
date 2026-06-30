/** Prints ONLY the Apollo Veezi siteToken (from the live agent prompt) to stdout,
 *  so it can be piped into `vercel env add` without echoing it. dotenv's stdout
 *  chatter is silenced so the piped value is exactly the token (no newlines). */
import * as dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

const _write = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = () => true;   // hush dotenv during config()
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
(process.stdout as any).write = _write;        // restore — only the token goes out

(async () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const agent = await (client.beta.agents as any).retrieve(process.env.APOLLO_AGENT_ID || 'agent_011JUMEmkFKkyJRckbWongao');
  const sys = agent.system ?? agent.system_prompt ?? '';
  const token = (sys.match(/siteToken=([A-Za-z0-9_-]+)/) || [])[1];
  if (!token) { process.stderr.write('siteToken not found in agent prompt\n'); process.exit(1); }
  process.stdout.write(token); // no trailing newline
})().catch(e => { process.stderr.write(String(e.message) + '\n'); process.exit(1); });
