import {
  announcementTitleNeedsAction,
  isPermanentImageFailure,
  planQueueConformance,
  type PendingEventRow,
} from '@/lib/queueConformance';

function pendingRow(overrides: Record<string, unknown> = {}): PendingEventRow {
  return {
    id: 10,
    source_id: 3,
    event_type: 'ot',
    title: 'Community Jazz Night',
    description: 'An evening of live community jazz in downtown Oberlin.',
    extended_description: null,
    sponsors: JSON.stringify(['Oberlin Community Arts']),
    post_type_ids: JSON.stringify([8]),
    sessions: JSON.stringify([{ startTime: 4_102_444_800, endTime: 4_102_448_400 }]),
    location_type: 'ne',
    location: null,
    display: 'all',
    screen_ids: '[]',
    buttons: '[]',
    website: null,
    image_cdn_url: null,
    email: 'calendar@oberlin.edu',
    ...overrides,
  } as PendingEventRow;
}

describe('planQueueConformance', () => {
  it('leaves an already conforming event untouched', () => {
    const plan = planQueueConformance(pendingRow());
    expect(plan.decision).toBe('leave');
    expect(plan.updates).toEqual({});
    expect(plan.validation_errors).toEqual([]);
  });

  it('corrects a queued Apollo announcement to the agreed exact title', () => {
    const plan = planQueueConformance(pendingRow({
      event_type: 'an',
      title: 'Apollo - Coming Soon',
      description: 'Minions - opens Jul 25.',
    }));
    expect(plan.decision).toBe('correct');
    expect(plan.updates.title).toBe('Coming Soon to the Apollo');
    // The re-scrape signature follows the corrected content.
    expect(typeof plan.updates.dedup_key).toBe('string');
    expect(plan.notes.join(' ')).toContain('Coming Soon to the Apollo');
  });

  it('applies the registration marker and button to an old-format event', () => {
    const plan = planQueueConformance(pendingRow({
      description: 'A hands-on pottery class. Register now to reserve a wheel.',
      website: 'https://studio.example.org/classes',
    }));
    expect(plan.decision).toBe('correct');
    expect(String(plan.updates.description)).toMatch(/Registration required\.$/);
    const buttons = plan.updates.buttons as Array<{ title: string; link: string }>;
    expect(buttons[0]).toEqual({ title: 'Register', link: 'https://studio.example.org/classes' });
  });

  it('strips URLs and the event address from a queued long description', () => {
    const plan = planQueueConformance(pendingRow({
      location_type: 'ph2',
      location: '39 South Main Street, Oberlin, OH 44074',
      extended_description:
        'Workshop details and materials list. More info: https://fava.example.org/w '
        + 'at 39 South Main Street, Oberlin, OH 44074.',
    }));
    expect(plan.decision).toBe('correct');
    const extended = String(plan.updates.extended_description ?? '');
    expect(extended).not.toContain('https://');
    expect(extended).not.toContain('39 South Main Street');
  });

  it('rejects a queued event that still misses required fields', () => {
    const plan = planQueueConformance(pendingRow({ post_type_ids: '[]' }));
    expect(plan.decision).toBe('reject_missing_required');
    expect(plan.notes[0]).toBe('Required fields are missing.');
    expect(plan.notes.join(' ')).toContain('postTypeId');
  });

  it('rejects a noun-only announcement title when the copy proves an action', () => {
    const plan = planQueueConformance(pendingRow({
      event_type: 'an',
      title: 'Summer Symphony',
      description: 'Registration is required for the summer symphony day camp.',
      website: 'https://symphony.example.org/camp',
    }));
    expect(plan.decision).toBe('reject_format');
    expect(plan.notes.join(' ')).toContain('does not state the action');
  });

  it('keeps a noun-only announcement title when there is nothing to act on', () => {
    const plan = planQueueConformance(pendingRow({
      event_type: 'an',
      title: 'Road Closure Downtown',
      description: 'Main Street closes for repaving during the third week of July.',
    }));
    expect(plan.decision).toBe('leave');
  });
});

describe('idempotence', () => {
  it('leaves an already corrected event alone even with MySQL-sorted JSON keys', () => {
    // A row the sweep itself corrected earlier: marker present, Register
    // button stored by MySQL with alphabetized object keys.
    const plan = planQueueConformance(pendingRow({
      description: 'A hands-on pottery class. Register now to reserve a wheel. Registration required.',
      website: 'https://studio.example.org/classes',
      buttons: JSON.stringify([{ link: 'https://studio.example.org/classes', title: 'Register' }]),
    }));
    expect(plan.decision).toBe('leave');
    expect(plan.updates).toEqual({});
  });
});

describe('announcementTitleNeedsAction', () => {
  it('accepts action-led and agreed Apollo titles', () => {
    for (const title of [
      'Register for Summer Art Camp',
      'Participate in the river cleanup',
      'Now Playing at the Apollo',
      'Coming Soon to the Apollo',
      'Camp: 2026 Summer Art Camp (6-12)',
    ]) {
      expect(announcementTitleNeedsAction(pendingRow({
        event_type: 'an',
        title,
        description: 'Registration is required for this program.',
        website: 'https://example.org/register',
      }))).toBe(false);
    }
  });

  it('never flags plain events', () => {
    expect(announcementTitleNeedsAction(pendingRow({
      event_type: 'ot',
      title: 'Summer Symphony',
      description: 'Registration is required for the summer symphony day camp.',
      website: 'https://example.org/register',
    }))).toBe(false);
  });
});

describe('isPermanentImageFailure', () => {
  it('classifies unfixable codes as permanent and network blips as retryable', () => {
    expect(isPermanentImageFailure('INVALID_URL')).toBe(true);
    expect(isPermanentImageFailure('UNSUPPORTED_TYPE')).toBe(true);
    expect(isPermanentImageFailure('INVALID_IMAGE')).toBe(true);
    expect(isPermanentImageFailure('UPSTREAM_TIMEOUT')).toBe(false);
    expect(isPermanentImageFailure('FETCH_FAILED')).toBe(false);
    expect(isPermanentImageFailure('UPSTREAM_STATUS')).toBe(false);
  });
});
