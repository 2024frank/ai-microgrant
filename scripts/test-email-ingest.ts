/**
 * Tests the email ingestion pipeline without touching the DB.
 * Connects to IMAP, fetches unread emails, extracts events via Claude.
 * Does NOT mark emails as read or write to DB.
 *
 * Usage: npx tsx scripts/test-email-ingest.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { fetchUnreadEmails, extractEventsFromEmail } from '../src/lib/emailFetch';

async function main() {
  console.log('Connecting to IMAP...');
  const emails = await fetchUnreadEmails();
  console.log(`Found ${emails.length} unread email(s)\n`);

  if (emails.length === 0) {
    console.log('No unread emails. Send a test newsletter to eve@communityhub.cloud and try again.');
    return;
  }

  for (const email of emails) {
    console.log(`--- Email uid=${email.uid} ---`);
    console.log('From:', email.from);
    console.log('Subject:', email.subject);
    console.log('Body preview:', email.body.slice(0, 200));
    console.log('\nExtracting events via Claude...');

    const events = await extractEventsFromEmail(email);
    console.log(`Extracted ${events.length} event(s):`);
    for (const ev of events) {
      console.log(`  • [${ev.eventType}] ${ev.title}`);
      console.log(`    desc: ${ev.description}`);
      if (ev.extendedDescription) console.log(`    ext:  ${ev.extendedDescription.slice(0, 100)}`);
      if (ev.sessions?.length) console.log(`    sessions: ${JSON.stringify(ev.sessions[0])}`);
    }
    console.log('');
  }
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
