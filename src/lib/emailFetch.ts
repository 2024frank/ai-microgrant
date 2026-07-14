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
- eventType    — "ot" for events, "an" for announcements, "jp" for jobs
- sponsors     — non-empty string array containing only organizers/sponsors stated in the email
- postTypeId   — non-empty number array. Choose only from the Oberlin IDs listed below.
- sessions     — non-empty array of { startTime, endTime } integer Unix timestamps in seconds.
                 For announcements spanning a date range use one session covering the full range.
                 Never use ISO strings or 13-digit millisecond timestamps.
- description  (string, 10-200 chars) — one-sentence teaser, complete, no trailing "..."
- extendedDescription (string, ≤ 1000 chars) — full details: date/time, location,
                 registration, cost, who it's for, contact info. Faithful to the email.
- locationType — "ph2" physical, "on" online, "bo" both, "ne" neither
- display      — "all", "ps", "sps", or "ss"; normally use "all"

OPTIONAL (include when present in the email):
- location     (string) — physical address or room
- urlLink      (string) — event URL or registration link
- calendarSourceName (string) — name of the organisation sending the email
- calendarSourceUrl  (string) — URL of event page if linked in email

OBERLIN POST TYPE IDS:
1 Volunteer Opportunity; 2 Exhibit; 3 Fair/Festival/Public Celebration; 4 Tour/Open House;
5 Film; 6 Presentation/Lecture; 7 Workshop/Class; 8 Music Performance; 9 Theatre/Dance;
10 City Government; 11 Spectator Sport; 12 Participatory Sport/Game; 13 Networking;
59 Environmental/Ecolympics; 89 Other.

RULES:
- Extract ALL events mentioned in the email, even brief ones.
- If the email has no events (e.g. purely transactional), return [].
- Never invent information not in the email.
- Interpret local dates in America/New_York, then return Unix seconds for the correct instant.
- Return ONLY the raw JSON array, no markdown, no commentary.`;

interface ExtractedEvent {
  title: string;
  eventType: string;
  sponsors: string[];
  postTypeId: number[];
  sessions: { startTime: number; endTime: number }[];
  description: string;
  extendedDescription?: string;
  location?: string;
  locationType?: string;
  urlLink?: string;
  display: string;
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

export class EmailExtractionError extends Error {
  constructor(
    message: string,
    readonly code: 'missing_json' | 'malformed_json' | 'invalid_shape',
  ) {
    super(message);
    this.name = 'EmailExtractionError';
  }
}

export async function fetchUnreadEmails(maxEmails = 5): Promise<FetchedEmail[]> {
  const limit = Number.isFinite(maxEmails)
    ? Math.min(Math.max(Math.floor(maxEmails), 1), 100)
    : 5;
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
        if (emails.length >= limit) break;
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

export async function extractEventsFromEmail(
  email: FetchedEmail,
  timeoutMs = 60_000,
): Promise<ExtractedEvent[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userContent = [
    `FROM: ${email.from}`,
    `SUBJECT: ${email.subject}`,
    '',
    email.body,
  ].join('\n');

  const response = await anthropic.messages.create(
    {
      model:      'claude-sonnet-5',
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }],
    },
    { timeout: Math.min(Math.max(Math.floor(timeoutMs), 1_000), 60_000) },
  );

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('');

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new EmailExtractionError(
      'Email extractor returned no JSON array',
      'missing_json',
    );
  }

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) {
      throw new EmailExtractionError(
        'Email extractor JSON was not an array',
        'invalid_shape',
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof EmailExtractionError) throw error;
    throw new EmailExtractionError(
      'Email extractor returned malformed JSON',
      'malformed_json',
    );
  }
}
