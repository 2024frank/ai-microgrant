/**
 * Fetches unread emails from the inbox via IMAP and uses Claude to extract
 * structured events/announcements from each one. Returns a flat array of
 * event objects in the same shape accepted by the /api/ingest/:slug route.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You extract community events and announcements from email newsletters.

Given an email (sender, subject, body), return a JSON array of event objects.
Each event must have these fields:

REQUIRED:
- title        (string, ≤ 60 chars) — the event or announcement name
- eventType    — "ev" for single-time events, "an" for multi-day/ongoing announcements
- sessions     — array of { startTime, endTime } objects in ISO 8601 UTC.
                 For announcements spanning a date range use one session covering the full range.
                 If no date is mentioned, use an empty array [].
- description  (string, ≤ 200 chars) — one-sentence teaser, complete, no trailing "..."
- extendedDescription (string, ≤ 1000 chars) — full details: date/time, location,
                 registration, cost, who it's for, contact info. Faithful to the email.

OPTIONAL (include when present in the email):
- location     (string) — physical address or room
- locationType — "ph2" physical, "on" online, "bo" both, "ne" not specified
- urlLink      (string) — event URL or registration link
- postTypeId   (number[]) — choose from: 2 Exhibit, 7 Workshop/Class, 10 Community Event,
                 11 Arts & Culture, 12 Sports & Recreation, 13 Family & Kids, 14 Food & Drink,
                 15 Music, 16 Film, 17 Lecture & Discussion, 18 Fundraiser
- calendarSourceName (string) — name of the organisation sending the email
- calendarSourceUrl  (string) — URL of event page if linked in email

RULES:
- Extract ALL events mentioned in the email, even brief ones.
- If the email has no events (e.g. purely transactional), return [].
- Never invent information not in the email.
- All times must be in Eastern Time converted to UTC.
- Return ONLY the raw JSON array, no markdown, no commentary.`;

interface ExtractedEvent {
  title: string;
  eventType: string;
  sessions: { startTime: string; endTime: string }[];
  description: string;
  extendedDescription?: string;
  location?: string;
  locationType?: string;
  urlLink?: string;
  postTypeId?: number[];
  calendarSourceName?: string;
  calendarSourceUrl?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

export interface FetchedEmail {
  uid: number;
  from: string;
  subject: string;
  body: string;
}

export async function fetchUnreadEmails(): Promise<FetchedEmail[]> {
  const client = new ImapFlow({
    host:   process.env.IMAP_HOST || 'imap.titan.email',
    port:   parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
    logger: false,
  });

  const emails: FetchedEmail[] = [];
  await client.connect();

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Fetch all unseen messages
      const uids: number[] = [];
      for await (const msg of client.fetch('1:*', { flags: true })) {
        if (!msg.flags?.has('\\Seen')) uids.push(msg.uid);
      }

      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const body = parsed.text
          ? parsed.text.slice(0, 8000)
          : parsed.html
          ? stripHtml(parsed.html).slice(0, 8000)
          : '';

        if (!body.trim()) continue;

        emails.push({
          uid,
          from:    (parsed.from?.text || '').slice(0, 200),
          subject: (parsed.subject   || '').slice(0, 200),
          body,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return emails;
}

export async function markEmailsRead(uids: number[]): Promise<void> {
  if (uids.length === 0) return;
  const client = new ImapFlow({
    host:   process.env.IMAP_HOST || 'imap.titan.email',
    port:   parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export async function extractEventsFromEmail(email: FetchedEmail): Promise<ExtractedEvent[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userContent = [
    `FROM: ${email.from}`,
    `SUBJECT: ${email.subject}`,
    '',
    email.body,
  ].join('\n');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-5',
    max_tokens: 4096,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('');

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}
