import {
  buildCommunityHubPayload,
  CommunityHubPayloadValidationError,
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
  sessions: [{ startTime: 1760000000, endTime: 1760007200 }],
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
        { startTime: '1760100000', endTime: '1760103600' },
        { startTime: 1760000000, endTime: 1760007200 },
        { startTime: 1760000000, endTime: 1760007200 },
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
      { startTime: 1760000000, endTime: 1760007200 },
      { startTime: 1760100000, endTime: 1760103600 },
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

  it('rejects descriptions below the documented minimum length', () => {
    expect(errorPaths({ ...BASE, description: 'Too short' })).toContain('description');
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
