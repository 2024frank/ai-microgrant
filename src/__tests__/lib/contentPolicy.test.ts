import {
  applyContentPolicy,
  PAID_SENTENCE,
  REGISTRATION_SENTENCE,
  SHORT_DESCRIPTION_MAX,
} from '@/lib/contentPolicy';

describe('applyContentPolicy', () => {
  describe('registration handling', () => {
    it('prepends a Register button and appends the registration marker within the length cap', () => {
      // No sentence punctuation so the trim must land on a word boundary.
      const base =
        'The visiting scholar lecture covers the history of campus architecture '
        + 'and the restoration of the oldest buildings on the square with time for '
        + 'questions from students faculty and community members afterwards in the main hall';
      expect(base.length).toBeGreaterThan(SHORT_DESCRIPTION_MAX);

      const result = applyContentPolicy({
        title: 'Scholar Lecture',
        description: base,
        registrationUrl: 'https://x.example/reg',
        buttons: [{ title: 'More Info', link: 'https://x.example/info' }],
      });

      const description = result.record.description as string;
      expect(description.endsWith(REGISTRATION_SENTENCE)).toBe(true);
      expect(description.length).toBeLessThanOrEqual(SHORT_DESCRIPTION_MAX);

      // The kept prefix is an exact word-boundary cut of the original text,
      // closed with a period so the marker reads as its own sentence.
      const prefix = description.slice(0, -(REGISTRATION_SENTENCE.length + 1));
      expect(prefix.endsWith('.')).toBe(true);
      const prefixWithoutPeriod = prefix.slice(0, -1);
      expect(base.startsWith(prefixWithoutPeriod)).toBe(true);
      expect(base.charAt(prefixWithoutPeriod.length)).toBe(' ');

      const buttons = result.record.buttons as Array<{ title: string; link: string }>;
      expect(buttons[0]).toEqual({ title: 'Register', link: 'https://x.example/reg' });
      expect(buttons[1]).toEqual({ title: 'More Info', link: 'https://x.example/info' });
      expect(result.issues).toEqual([]);
    });

    it('never adopts the website field as the registration URL', () => {
      // The website field is REQUIRED and platform-filled (organization site
      // or event page), so treating it as a registration link would fabricate
      // Register buttons pointing at generic pages.
      const result = applyContentPolicy({
        title: 'Community Workshop',
        description: 'Register now to join.',
        website: 'https://x.example/site',
      });

      const buttons = result.record.buttons as Array<{ title: string; link: string }>;
      expect(buttons).toEqual([]);
      expect(result.adjustments).not.toContain('registration URL adopted from website field');
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: 'registrationUrl', code: 'required' }),
      );
    });

    it('reports a required issue and skips the marker when registration has no valid URL', () => {
      const result = applyContentPolicy({
        title: 'Members Meeting',
        description: 'Club meeting for members.',
        registrationRequired: true,
      });

      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: 'registrationUrl', code: 'required' }),
      );
      const description = result.record.description as string;
      expect(description).toBe('Club meeting for members.');
      expect(description.endsWith(REGISTRATION_SENTENCE)).toBe(false);
    });
  });

  describe('paid handling', () => {
    it('marks the description paid when the text mentions a dollar amount', () => {
      const result = applyContentPolicy({
        title: 'Trivia Night',
        description: 'Fun night with $10 admission at the door.',
      });
      expect(result.record.description as string).toContain(PAID_SENTENCE);
    });

    it('marks the description paid when a ticket purchase button is present', () => {
      const result = applyContentPolicy({
        title: 'Jazz Evening',
        description: 'An evening of jazz.',
        buttons: [{ title: 'Buy Tickets', link: 'https://x.example/tix' }],
      });
      expect(result.record.description as string).toContain(PAID_SENTENCE);
    });

    it('does not mark paid when the text says admission is free', () => {
      const result = applyContentPolicy({
        title: 'Gallery Opening',
        description: 'Free admission for all students.',
      });
      expect(result.record.description as string).not.toContain(PAID_SENTENCE);
    });

    it('does not mark paid without any cost evidence', () => {
      const result = applyContentPolicy({
        title: 'Games Night',
        description: 'Casual games night.',
      });
      expect(result.record.description as string).not.toContain(PAID_SENTENCE);
    });
  });

  describe('long description cleanup', () => {
    it('strips https and www URLs from the long description and records the adjustment', () => {
      const result = applyContentPolicy({
        title: 'Maker Meetup',
        description: 'Weekly maker meetup in the lab.',
        extendedDescription:
          'Full schedule at https://example.com/schedule and updates at www.example.org/updates every week.',
      });

      const extended = result.record.extendedDescription as string;
      expect(extended).not.toContain('http');
      expect(extended).not.toContain('www.');
      expect(result.adjustments).toContain('removed 2 URLs from the long description');
    });

    it('removes the stored event address from the long description', () => {
      const result = applyContentPolicy({
        title: 'Beginner Workshop',
        description: 'Hands-on pottery for beginners.',
        location: '123 Main Street, Oberlin, OH',
        extendedDescription:
          'Bring an apron to 123 Main Street, Oberlin, OH with snacks provided afterwards.',
      });

      const extended = result.record.extendedDescription as string;
      expect(extended).not.toContain('123 Main Street');
      expect(result.adjustments).toContain('removed the event address from the long description');
    });

    it('drops a long description identical to the short description', () => {
      const result = applyContentPolicy({
        title: 'Potluck',
        description: 'Community potluck with live music.',
        extendedDescription: 'Community potluck with live music.',
      });

      expect(result.record.extendedDescription).toBeUndefined();
      expect(result.adjustments).toContain(
        'dropped the long description because it duplicated the short description',
      );
    });

    it('promotes a short extension of a truncated description and drops the long field', () => {
      const result = applyContentPolicy({
        title: 'Potluck',
        description: 'Community potluck with live',
        extendedDescription: 'Community potluck with live music and games.',
      });

      expect(result.record.description).toBe('Community potluck with live music and games.');
      expect(result.record.extendedDescription).toBeUndefined();
      expect(result.adjustments).toContain(
        'used the full source description as the short description and dropped the long description',
      );
    });

    it('keeps a genuinely different long description over the short limit', () => {
      const longExtended =
        'The annual science fair brings together student projects from every department '
        + 'with demonstrations running throughout the afternoon judges circulating between '
        + 'tables and awards presented in the evening followed by a reception for participants '
        + 'and their families in the atrium';
      expect(longExtended.length).toBeGreaterThan(SHORT_DESCRIPTION_MAX);

      const result = applyContentPolicy({
        title: 'Science Fair',
        description: 'Annual science fair.',
        extendedDescription: longExtended,
      });

      expect(result.record.description).toBe('Annual science fair.');
      expect(result.record.extendedDescription).toBe(longExtended);
    });
  });

  describe('ambiguous location wording', () => {
    it('flags "takes place here" for the reviewer', () => {
      const result = applyContentPolicy({
        title: 'Pottery Basics',
        description: 'Pottery basics for beginners.',
        extendedDescription: 'The workshop takes place here.',
      });

      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: 'description', code: 'ambiguous_location_wording' }),
      );
    });

    it('does not flag harmless uses of the word there', () => {
      const result = applyContentPolicy({
        title: 'Snack Social',
        description: 'There will be food.',
      });

      expect(result.issues).toEqual([]);
    });
  });

  describe('review fixes', () => {
    it('treats "No registration required" as the opposite of registration evidence', () => {
      const result = applyContentPolicy({
        title: 'Community Picnic',
        description: 'A community picnic in the park. No registration required.',
        website: 'https://x.example/picnic',
      });

      const description = result.record.description as string;
      expect(description).not.toContain(REGISTRATION_SENTENCE);
      expect(result.issues).toEqual([]);
      expect(result.record.buttons).toEqual([]);
    });

    it('adopts a registration URL found only in the prose and strips it from the short description', () => {
      const result = applyContentPolicy({
        title: 'Coding Camp',
        description: 'Register now at https://x.example/camp to reserve a spot.',
      });

      const description = result.record.description as string;
      expect(description).not.toContain('https://x.example/camp');
      expect(description.endsWith(REGISTRATION_SENTENCE)).toBe(true);
      const buttons = result.record.buttons as Array<{ title: string; link: string }>;
      expect(buttons[0]).toEqual({ title: 'Register', link: 'https://x.example/camp' });
      expect(result.issues).toEqual([]);
    });

    it('keeps an identical long description when it overflows the short field', () => {
      const overflow = `The lineup covers ${'many films and special screenings across the whole week '.repeat(5)}with details for each showing.`;
      expect(overflow.length).toBeGreaterThan(200);
      const result = applyContentPolicy({
        title: 'Now Playing at the Apollo',
        description: overflow,
        extendedDescription: overflow,
      });

      // The short field will be trimmed to 200 downstream; the long copy
      // preserves the tail and must not be dropped as a duplicate.
      expect(result.record.extendedDescription).toBe(overflow);
    });
  });

  describe('schedule restatements in the long description', () => {
    it('removes sentences that restate the event schedule and keeps the rest', () => {
      const result = applyContentPolicy({
        title: 'Workshop: Open Pottery Pop In (14+)',
        description: 'Two-hour beginner pottery wheel workshop for ages 14+ at FAVA.',
        extendedDescription:
          'Meets August 19, 2026, from 5:30 to 7:30pm. Get a basic introduction to '
          + 'throwing on the wheel in this two-hour beginner workshop. Keep your best '
          + 'pot, choose a glaze, and pick it up from the shop when ready. Instructor: Erin McCarty.',
      });
      const extended = String(result.record.extendedDescription ?? '');
      expect(extended).not.toContain('August 19');
      expect(extended).not.toContain('5:30');
      expect(extended).toContain('Get a basic introduction');
      expect(extended).toContain('Instructor: Erin McCarty.');
      expect(result.adjustments.join(' ')).toContain('schedule restatement');
    });

    it('removes labeled and bare date-time lines', () => {
      const result = applyContentPolicy({
        title: 'Concert on the Square',
        description: 'An outdoor evening concert on the town square.',
        extendedDescription:
          'When: Friday, July 24 at 7:00pm. Saturday, July 25, 2026, 7:00 pm. Bring a lawn chair and a picnic.',
      });
      const extended = String(result.record.extendedDescription ?? '');
      expect(extended).toBe('Bring a lawn chair and a picnic.');
    });

    it('keeps actionable dates that are not the event schedule', () => {
      const result = applyContentPolicy({
        title: 'Mural Contest',
        description: 'A community mural design contest for local artists.',
        extendedDescription:
          'Deadline to submit designs is August 1, 2026. Winners are announced at the gallery reception.',
      });
      const extended = String(result.record.extendedDescription ?? '');
      expect(extended).toContain('Deadline to submit designs is August 1, 2026.');
    });
  });

  describe('no invention', () => {
    it('leaves a plain event untouched with no markers, issues, or adjustments', () => {
      const result = applyContentPolicy({
        title: 'Open Studio',
        description: 'Open studio hours for ceramics.',
      });

      const description = result.record.description as string;
      expect(description).toBe('Open studio hours for ceramics.');
      expect(description).not.toContain(PAID_SENTENCE);
      expect(description).not.toContain(REGISTRATION_SENTENCE);
      expect(result.issues).toEqual([]);
      expect(result.adjustments).toEqual([]);
    });
  });
});
