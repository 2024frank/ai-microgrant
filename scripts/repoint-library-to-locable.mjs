import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import Anthropic from '@anthropic-ai/sdk';

/**
 * Repoint the Oberlin Public Library extraction agent from the WhoFi JSON
 * feed (no images, time-prefixed titles) to the library's Locable calendar,
 * where every event page carries its own share image (og:image), clean
 * titles, and real end times. Only the source-specific section is replaced;
 * the canonical contract at the top of the prompt is preserved verbatim.
 */
const AGENT_ID = 'agent_01YKQJ19yJ8ttRYzXTcmDwKa';

const NEW_SOURCE_SECTION = `## Source-specific instructions for Oberlin Public Library

Extract from the library's public events calendar on Locable. It is the authoritative listing, and every event's own page carries its real image, description, and end time.

## STEP 1 - Collect the event list
Fetch the events index and follow its pagination to the end:
- https://oberlin-public-library.locable.com/events/
- https://oberlin-public-library.locable.com/events/?page=2
- https://oberlin-public-library.locable.com/events/?page=3
Keep following the "Next" link until there is no next page. Each card shows a title, a date and time, an address, and a "Read More" link to the event's own detail page.

## STEP 2 - Open each event's detail page
For every event, open its detail page (the "Read More" link, for example https://oberlin-public-library.locable.com/2026/07/15/558359/l-e-g-o/) and read:
- the clean event title exactly as shown (for example "L.E.G.O.", "Storytime at Oberlin Public Library", "Reading Buddies with Maya the Therapy Dog") - never a time-prefixed title.
- the description paragraph.
- the start and end time. The page states a range (for example "4:00 PM to 5:30 PM"); use both ends. Only when the page truly shows a single time with no end should you leave the end unset.
- the street address and any room.
- the event image: read the page's og:image meta tag and set image_cdn_url to that public https URL. Every Locable event page has one, and it is the event's real image, not a logo. Only if a page genuinely exposes no og:image, omit image_cdn_url and record why in fieldNotes.image_cdn_url.

## STEP 3 - Recurring programs are ONE event
Several programs repeat weekly (L.E.G.O., Storytime, Reading Buddies, Oberlin Writers, and others). Submit each program as ONE event whose sessions array holds its upcoming occurrences - one {startTime, endTime} per date - never one event per date. For perpetual weekly programs (Storytime, book and writers groups) include only the next four or so upcoming occurrences, about a month of coverage, not the endless series. Include every distinct program found across all index pages; keep only occurrences dated today or later in America/New_York.

## STEP 4 - Fixed library facts
- calendarSourceName: "Oberlin Public Library"
- calendarSourceUrl and website: the specific Locable detail page URL for that event.
- sponsors: ["Oberlin Public Library"].
- contactEmail: "info@oberlinlibrary.org". phone: "440-775-4790".
- locationType "ph2"; location is the stated street address (for example "65 S Main Street, Oberlin, OH 44074"); placeName "Oberlin Public Library"; roomNum only when the page names a room.
- Choose postTypeId from the category list in the contract above (children's storytime and hands-on programs are Workshop or Class; music events are Music Performance; talks are Presentation or Lecture). Never guess a category the program does not fit.`;

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const current = await client.beta.agents.retrieve(AGENT_ID);
  const system = String(current.system ?? '');
  const idx = system.indexOf('## Source-specific instructions');
  if (idx < 0) throw new Error('canonical/source boundary not found');
  const canonical = system.slice(0, idx).replace(/\s+$/, '');
  const nextSystem = `${canonical}\n\n${NEW_SOURCE_SECTION}\n\nReturn only the JSON array.`;

  if (system.includes('locable.com') && !system.includes('whofi.com')) {
    console.log('Already on Locable; no change. version:', current.version);
    return;
  }
  const updated = await client.beta.agents.update(AGENT_ID, {
    version: current.version,
    system: nextSystem,
  });
  const verify = String(updated.system ?? '');
  console.log('updated version:', current.version, '->', updated.version);
  console.log('mentions locable:', verify.includes('locable.com'), '| mentions whofi:', verify.includes('whofi.com'));
  console.log('canonical intact:', verify.includes('Duplicate checking is your responsibility'),
    '| image REQUIRED:', verify.includes('image_cdn_url: REQUIRED'),
    '| fieldNotes:', verify.includes('add an entry to fieldNotes'));
}

main().catch(err => { console.error('ERR', err.message); process.exit(1); });
