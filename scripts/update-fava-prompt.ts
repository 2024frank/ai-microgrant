/**
 * Patches the FAVA agent system prompt to fix truncated descriptions.
 * Only changes Step 3F (classes/workshops) and Step 4A (exhibitions):
 * - description  → short teaser ≤200 chars, complete, no "..."
 * - extendedDescription → all the real details
 *
 * Usage: npx tsx scripts/update-fava-prompt.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';

const AGENT_ID = 'agent_01GiCvrVVtE8fjNjnbZdCBsE';

const OLD_3F = `F. Description = the real details: the class's ACTUAL run dates/times, instructor, price, what participants do. Lead with "Register now! " when (D) applies. Faithful to the page; no hype, no invented details.`;

const NEW_3F = `F. DESCRIPTIONS — split into short and long:
   - \`description\` (≤ 200 chars, **complete sentence, no trailing "..."**): A concise teaser — state what the class/workshop is and who it's for. Lead with "Register now! " when (D) applies. End with a full stop. Example: "Register now! Beginner wheel-throwing class at FAVA for ages 14+. All materials included; no experience needed."
   - \`extendedDescription\` (max 1000 chars): All the real details — the class's actual run dates and times for every session, total number of sessions/weeks, instructor name, full tuition (member and non-member price), age or prerequisite requirements, materials policy, and any other practical information from the page. Faithful to the page; no hype, no invented details.`;

const OLD_4A_DESC = `   - description = what the show is`;

const NEW_4A_DESC = `   - description = what the show is (≤ 200 chars, complete sentence, no trailing "...")`;

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log('Fetching FAVA agent...');
  const current = await (client.beta.agents as any).retrieve(AGENT_ID);
  console.log('Current version:', current.version);

  let system: string = current.system ?? '';

  if (!system.includes(OLD_3F.slice(0, 40))) {
    console.error('ERROR: Step 3F text not found — prompt may have changed. Aborting.');
    process.exit(1);
  }

  system = system.replace(OLD_3F, NEW_3F);
  system = system.replace(OLD_4A_DESC, NEW_4A_DESC);

  console.log('Updating system prompt...');
  const updated = await (client.beta.agents as any).update(AGENT_ID, {
    system,
    version: current.version,
  });

  console.log('✓ Updated to version:', updated.version);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
