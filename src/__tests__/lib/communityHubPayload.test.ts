import {
  buildCommunityHubPayload,
  CommunityHubPayloadValidationError,
  getCommunityHubExpirationIssue,
  normalizeCommunityHubPayload,
  validateCommunityHubPayload,
} from '@/lib/communityHubPayload';

const BASE = {
  eventType: 'ot',
  email: 'events@oberlin.edu',
  title: 'Community Art Workshop',
  description: 'Create a neighborhood mural with local artists and volunteers.',
  sponsors: ['Oberlin Arts Council'],
  postTypeId: [7],
  sessions: [{ startTime: 2000000000, endTime: 2000007200 }],
  locationType: 'ph2',
  location: '123 Main Street, Oberlin, OH 44074',
  display: 'all',
  screensIds: [],
};

function errorPaths(input: unknown): string[] {
  const result = validateCommunityHubPayload(input);
  if (result.success) return [];
  return result.errors.map(error => error.path);
}

describe('CommunityHub payload contract', () => {
  it('normalizes raw_events aliases and canonicalizes arrays', () => {
    const result = validateCommunityHubPayload({
      event_type: 'ev',
      email: ' events@oberlin.edu ',
      title: '  Community   Art Workshop  ',
      description: BASE.description,
      sponsors: JSON.stringify([' Oberlin Arts Council ', 'oberlin arts council', 'City Parks']),
      post_type_ids: JSON.stringify(['89', 7, 7]),
      sessions: JSON.stringify([
        { startTime: '2000100000', endTime: '2000103600' },
        { startTime: 2000000000, endTime: 2000007200 },
        { startTime: 2000000000, endTime: 2000007200 },
      ]),
      location_type: 'ph2',
      location: BASE.location,
      display: 'all',
      screen_ids: JSON.stringify([4, 4]),
      buttons: JSON.stringify([
        { title: 'Register', link: 'https://example.org/register' },
        { title: 'Register', link: 'https://example.org/register' },
      ]),
      calendar_source_url: 'https://example.org/calendar',
      ingested_post_url: 'http://localhost:3000/events/10',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.eventType).toBe('ot');
    expect(result.data.title).toBe('Community Art Workshop');
    expect(result.data.sponsors).toEqual(['Oberlin Arts Council', 'City Parks']);
    expect(result.data.postTypeId).toEqual([7, 89]);
    expect(result.data.sessions).toEqual([
      { startTime: 2000000000, endTime: 2000007200 },
      { startTime: 2000100000, endTime: 2000103600 },
    ]);
    expect(result.data.screensIds).toEqual([]);
    expect(result.data.buttons).toEqual([
      { title: 'Register', link: 'https://example.org/register' },
    ]);
  });

  it('requires every documented collection', () => {
    const paths = errorPaths({
      ...BASE,
      sponsors: [],
      postTypeId: [],
      sessions: [],
    });
    expect(paths).toEqual(expect.arrayContaining(['sponsors', 'postTypeId', 'sessions']));
  });

  it('flags omitted location and display choices instead of hiding them behind defaults', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      locationType: undefined,
      display: undefined,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'locationType', code: 'required' }),
      expect.objectContaining({ path: 'display', code: 'required' }),
    ]));
    expect(result.normalized.locationType).toBe('ne');
    expect(result.normalized.display).toBe('all');
  });

  it.each([
    ['physical', { locationType: 'ph2', location: undefined }, 'location'],
    ['online', { locationType: 'on', location: undefined, urlLink: '' }, 'urlLink'],
    ['hybrid physical', { locationType: 'bo', location: undefined, urlLink: 'https://meet.example.org/room' }, 'location'],
    ['hybrid online', { locationType: 'bo', location: BASE.location, urlLink: '' }, 'urlLink'],
    ['specific screens', { display: 'ss', screensIds: [] }, 'screensIds'],
  ])('enforces the %s conditional requirement', (_name, overrides, expectedPath) => {
    expect(errorPaths({ ...BASE, ...overrides })).toContain(expectedPath);
  });

  it('accepts valid online and hybrid locations', () => {
    expect(validateCommunityHubPayload({
      ...BASE,
      locationType: 'on',
      location: undefined,
      urlLink: 'https://meet.example.org/room',
    }).success).toBe(true);
    expect(validateCommunityHubPayload({
      ...BASE,
      locationType: 'bo',
      urlLink: 'https://meet.example.org/room',
    }).success).toBe(true);
  });

  it('clears physical place identity for non-physical location types', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      locationType: 'on',
      location: undefined,
      urlLink: 'https://meet.example.org/room',
      placeId: 'stale-physical-place',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.placeId).toBe('');
  });

  it('reports when every normalized session has ended', () => {
    expect(getCommunityHubExpirationIssue([
      { startTime: 100, endTime: 150 },
    ], 200)).toMatchObject({ path: 'sessions', code: 'expired' });
    expect(getCommunityHubExpirationIssue([
      { startTime: 100, endTime: 200 },
    ], 200)).toBeNull();
  });

  it('rejects unknown event types, categories, and invalid session ranges', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      eventType: 'concert',
      postTypeId: [7, 999],
      sessions: [{ startTime: 1760007200, endTime: 1760000000 }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'eventType', code: 'invalid_enum' }),
      expect.objectContaining({ path: 'postTypeId[1]', code: 'unknown_id' }),
      expect.objectContaining({ path: 'sessions[0].endTime', code: 'invalid_range' }),
      expect.objectContaining({ path: 'sessions', code: 'required' }),
    ]));
  });

  it('rejects millisecond timestamps where Unix seconds are required', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      sessions: [{ startTime: 1760000000000, endTime: 1760007200000 }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'sessions[0].startTime',
      code: 'invalid_timestamp',
    }));
  });

  it('validates email, phone, URLs, and button links', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      email: 'not-an-email',
      contactEmail: 'also-invalid',
      phone: 'call me maybe',
      website: 'example.org',
      buttons: [{ title: 'Register', link: 'javascript:alert(1)' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'email', code: 'invalid_email' }),
      expect.objectContaining({ path: 'contactEmail', code: 'invalid_email' }),
      expect.objectContaining({ path: 'phone', code: 'invalid_phone' }),
      expect.objectContaining({ path: 'website', code: 'invalid_url' }),
      expect.objectContaining({ path: 'buttons[0].link', code: 'invalid_url' }),
    ]));
  });

  it('rejects private or local image proxy targets', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      image_cdn_url: 'http://169.254.169.254/latest/meta-data',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'image_cdn_url',
      code: 'non_public_url',
    }));
  });

  it('trims long text at safe boundaries without exceeding API limits', () => {
    const payload = buildCommunityHubPayload({
      ...BASE,
      title: `A deliberately long workshop title ${'with more details '.repeat(5)}`,
      description: `This complete opening sentence fits safely. ${'Additional description words '.repeat(20)}`,
      extendedDescription: `${'A complete extended description sentence. '.repeat(60)}`,
    });
    expect(payload.title.length).toBeLessThanOrEqual(60);
    expect(payload.title.endsWith(' ')).toBe(false);
    expect(payload.description.length).toBeLessThanOrEqual(200);
    expect(payload.description).toMatch(/[.!?]$/);
    expect(payload.extendedDescription?.length).toBeLessThanOrEqual(1000);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('omits extendedDescription from the payload when the input value is %s', (_name, value) => {
    const payload = buildCommunityHubPayload({ ...BASE, extendedDescription: value });
    // The key must be absent entirely, not present with an empty value.
    expect(Object.hasOwn(payload, 'extendedDescription')).toBe(false);
    expect(Object.keys(payload)).not.toContain('extendedDescription');
  });

  it('keeps a non-empty extendedDescription in the normalized payload', () => {
    const payload = buildCommunityHubPayload({
      ...BASE,
      extendedDescription: 'Doors open thirty minutes before the workshop begins.',
    });
    expect(payload.extendedDescription).toBe('Doors open thirty minutes before the workshop begins.');
  });

  it('rejects an event session whose end equals its start (live CommunityHub 500)', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      sessions: [{ startTime: 2000000000, endTime: 2000000000 }],
    });
    expect(result.success).toBe(false);
    expect((result as any).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sessions[0].endTime', code: 'end_equals_start' }),
    ]));
  });

  it('keeps an announcement display window valid at a single instant', () => {
    const result = validateCommunityHubPayload({
      ...BASE,
      eventType: 'an',
      locationType: 'ne',
      location: undefined,
      sessions: [{ startTime: 2000000000, endTime: 2000000000 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects descriptions below the documented minimum length', () => {
    expect(errorPaths({ ...BASE, description: 'Too short' })).toContain('description');
  });

  it('replaces em and en dashes with plain hyphens in every text field', () => {
    const payload = buildCommunityHubPayload({
      ...BASE,
      title: 'Apollo — Coming Soon',
      description: 'Tight harmonies — roots music at the barn, Jun 26–Jul 8.',
      extendedDescription: 'Doors at 7 PM ― music at 7:30.',
      sponsors: ['Riverdog Music — Henrietta'],
    });
    expect(payload.title).toBe('Apollo - Coming Soon');
    expect(payload.description).toBe('Tight harmonies - roots music at the barn, Jun 26-Jul 8.');
    expect(payload.extendedDescription).toBe('Doors at 7 PM - music at 7:30.');
    expect(payload.sponsors).toEqual(['Riverdog Music - Henrietta']);
  });

  it('maps legacy screen targeting conservatively', () => {
    const withScreens = validateCommunityHubPayload({
      ...BASE,
      display: 'screen',
      screensIds: [8, '8', 3],
    });
    expect(withScreens.success).toBe(true);
    if (withScreens.success) {
      expect(withScreens.data.display).toBe('ss');
      expect(withScreens.data.screensIds).toEqual([3, 8]);
    }

    expect(errorPaths({ ...BASE, display: 'none', screensIds: [] })).toContain('screensIds');
  });

  it('throws a typed error instead of publishing an invalid draft', () => {
    expect(() => buildCommunityHubPayload({ ...BASE, sponsors: [] }))
      .toThrow(CommunityHubPayloadValidationError);

    try {
      buildCommunityHubPayload({ ...BASE, sponsors: [] });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CommunityHubPayloadValidationError);
      expect((error as CommunityHubPayloadValidationError).issues)
        .toContainEqual(expect.objectContaining({ path: 'sponsors' }));
    }
  });

  it('exposes normalized data and issues for reviewer-facing diagnostics', () => {
    const normalized = normalizeCommunityHubPayload({
      ...BASE,
      postTypeId: [7, 'bad-id'],
    });
    expect(normalized.payload.postTypeId).toEqual([7]);
    expect(normalized.issues).toContainEqual(expect.objectContaining({
      path: 'postTypeId[1]',
      code: 'invalid_id',
    }));
  });
});
