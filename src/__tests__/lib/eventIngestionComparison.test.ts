import { persistExtractedEvents, resetInventoryCacheForTests } from '@/lib/eventIngestion';

const db = require('@/lib/db');

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const SOURCE = {
  id: 7,
  name: 'Oberlin Community Arts',
  calendar_source_name: 'Oberlin Community Arts',
};

const VALID_EVENT = {
  eventType: 'ot',
  title: 'Community Jazz Night',
  description: 'An evening of live community jazz in downtown Oberlin.',
  sponsors: ['Oberlin Community Arts'],
  postTypeId: [8],
  sessions: [{ startTime: 1_800_000_000, endTime: 1_800_003_600 }],
  locationType: 'ne',
  image_cdn_url: 'https://images.example.org/poster.jpg',
  display: 'all',
};

// A calendar post whose normalized title, session window, and event type all
// equal the VALID_EVENT candidate. Overrides shape each duplicate scenario.
function matchingRemotePost(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Community Jazz Night',
    eventType: 'ot',
    description: 'An evening of live community jazz in downtown Oberlin.',
    extendedDescription: '',
    calendarSourceName: 'Community Submitter',
    calendarSourceUrl: 'https://calendar.example.org/events/jazz-night',
    location: '',
    sponsors: [],
    organizations: [],
    sessions: [{ startTime: 1_800_000_000, endTime: 1_800_003_600 }],
    approved: true,
    ...overrides,
  };
}

// A post that matches nothing this suite ingests, keeping the inventory
// non-empty (the fetcher rejects a reported count of zero as invalid).
function unrelatedRemotePost() {
  return {
    name: 'Pottery Workshop Series',
    eventType: 'ot',
    description: 'Hand building pottery for beginners at the studio.',
    extendedDescription: '',
    calendarSourceName: 'Studio Collective',
    calendarSourceUrl: 'https://studio.example.org/events/pottery',
    location: '',
    sponsors: [],
    organizations: [],
    sessions: [{ startTime: 1_805_000_000, endTime: 1_805_003_600 }],
    approved: true,
  };
}

function inventoryResponse(posts: Record<string, unknown>[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      posts,
      lastPage: true,
      count: posts.length,
      unapprovedRecordsCount: 0,
    }),
  };
}

function findRawEventsInsert() {
  return db.mockConn.query.mock.calls.find(
    ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO raw_events'),
  );
}

function findComparisonInsert() {
  return db.default.query.mock.calls.find(
    ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO integration_run_comparisons'),
  );
}

describe('persistExtractedEvents comparison and duplicate handling', () => {
  beforeEach(() => {
    process.env.COMMUNITYHUB_EMAIL = 'calendar@oberlin.edu';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    resetInventoryCacheForTests();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(inventoryResponse([unrelatedRemotePost()]));
    db.default.query.mockReset().mockImplementation((sql: string) => {
      // Prior-report lookup and retained-local-rows lookup both expect a rows
      // array; everything else (the comparison upsert) takes a write result.
      if (typeof sql === 'string' && sql.includes('FROM integration_run_comparisons')) {
        return Promise.resolve([[]]);
      }
      if (typeof sql === 'string' && sql.includes('FROM raw_events')) {
        return Promise.resolve([[]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    db.default.getConnection.mockResolvedValue(db.mockConn);
    db.mockConn.query.mockReset();
    let nextId = 40;
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM raw_events')) {
        return Promise.resolve([[]]);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO raw_events')) {
        return Promise.resolve([{ insertId: nextId++ }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release = jest.fn();
  });

  it('sends a probable match without temporal evidence to review instead of suppressing it', async () => {
    // Same title, same generic calendar URL, same type, but a different week:
    // this is a NEW occurrence of a recurring event, not a duplicate.
    mockFetch.mockResolvedValue(inventoryResponse([matchingRemotePost({
      sessions: [{ startTime: 1_800_604_800, endTime: 1_800_608_400 }],
      description: 'A weekly evening of live community jazz.',
    }), unrelatedRemotePost()]));

    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      calendarSourceUrl: 'https://calendar.example.org/events/jazz-night',
    }], SOURCE, 12);

    expect(result.duplicates_preserved).toBe(0);
    expect(result.inserted).toHaveLength(1);
    const insert = findRawEventsInsert();
    expect(insert![1].at(-1)).toBe('pending');
    // The heuristic match still reaches the reviewer through the comparison.
    expect(result.comparison[0].outcome).toBe('inserted');
    expect(result.comparison[0].communityhub_match?.kind).toBe('probable');
  });

  it('skips a re-scrape of an identical rejected event instead of re-rejecting it', async () => {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM raw_events')
        && sql.includes("'rejected'")) {
        return Promise.resolve([[{ id: 91 }]]);
      }
      if (typeof sql === 'string' && sql.includes('SELECT id FROM raw_events')) {
        return Promise.resolve([[]]);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO raw_events')) {
        return Promise.resolve([{ insertId: 40 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      postTypeId: [999], // required-field failure that previously auto-rejected
    }], SOURCE, 12);

    expect(result.auto_rejected).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.comparison[0].outcome).toBe('duplicate_local');
    expect(findRawEventsInsert()).toBeUndefined();
  });

  it('preserves a CommunityHub duplicate as a duplicate row with match evidence', async () => {
    mockFetch.mockResolvedValue(inventoryResponse([matchingRemotePost({
      ingestedPostUrl: 'http://localhost:3000/reviewer/events/5',
    })]));

    const result = await persistExtractedEvents([VALID_EVENT], SOURCE, 12);

    expect(result.duplicates_preserved).toBe(1);
    expect(result.inserted).toHaveLength(0);
    expect(result.comparison[0].outcome).toBe('duplicate_communityhub');

    const insert = findRawEventsInsert();
    expect(insert).toBeDefined();
    // Parameter layout ends with [..., duplicate_of_id, communityhub_match, status].
    expect(insert![1].at(-1)).toBe('duplicate');
    const matchJson = insert![1].at(-2);
    expect(matchJson).not.toBeNull();
    const match = JSON.parse(matchJson);
    expect(match.kind).toBe('exact');
    expect(match.remote.submission_origin).toBe('this_application');
  });

  it('records direct-submission evidence and field diffs for the remote copy', async () => {
    // No ingestedPostUrl on the remote post and a differing extended description.
    mockFetch.mockResolvedValue(inventoryResponse([matchingRemotePost({
      extendedDescription: 'Neighbors bring instruments and join the second set.',
    })]));

    const result = await persistExtractedEvents([VALID_EVENT], SOURCE, 12);

    expect(result.duplicates_preserved).toBe(1);
    const insert = findRawEventsInsert();
    const match = JSON.parse(insert![1].at(-2));
    expect(match.remote.submission_origin).toBe('direct_submission');
    const extendedDiff = match.field_diffs.find(
      (diff: { field: string }) => diff.field === 'extended_description',
    );
    expect(extendedDiff).toBeDefined();
    expect(extendedDiff.equal).toBe(false);
    expect(extendedDiff.remote).toBe('Neighbors bring instruments and join the second set.');
  });

  it('records a local duplicate without writing a raw_events row', async () => {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('dedup_key') && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[{ id: 77 }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents([VALID_EVENT], SOURCE, 12);

    expect(result.duplicates).toBe(1);
    expect(result.duplicates_preserved).toBe(0);
    expect(result.inserted).toHaveLength(0);
    expect(result.comparison[0].outcome).toBe('duplicate_local');
    expect(result.comparison[0].duplicate_of_event_id).toBe(77);
    expect(findRawEventsInsert()).toBeUndefined();
  });

  it('preserves an aggregator candidate as a duplicate of the original-org event', async () => {
    const aggregatorSource = { ...SOURCE, source_kind: 'aggregator' as const };
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes("s.source_kind='original_org'")) {
        return Promise.resolve([[{ id: 55 }]]);
      }
      if (typeof sql === 'string' && sql.includes('SELECT id FROM raw_events')) {
        return Promise.resolve([[]]);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO raw_events')) {
        return Promise.resolve([{ insertId: 91 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents([VALID_EVENT], aggregatorSource, 12);

    expect(result.duplicates_preserved).toBe(1);
    expect(result.comparison[0].outcome).toBe('duplicate_cross_source');
    expect(result.comparison[0].duplicate_of_event_id).toBe(55);

    const insert = findRawEventsInsert();
    expect(insert).toBeDefined();
    expect(insert![1].at(-1)).toBe('duplicate');
    // duplicate_of_id sits directly before communityhub_match and status.
    expect(insert![1].at(-3)).toBe(55);
  });

  it('stamps configured organization metadata onto candidates that omit it', async () => {
    const librarySource = {
      id: 9,
      name: 'Library Events Page',
      calendar_source_name: 'Library Events',
      source_kind: 'original_org' as const,
      org_sponsor_name: 'Oberlin Public Library',
      org_website: 'https://oberlinlibrary.org',
      org_phone: '440-775-4790',
    };
    const eventWithoutOrgFields = Object.fromEntries(
      Object.entries(VALID_EVENT).filter(([key]) => key !== 'sponsors'),
    );

    const result = await persistExtractedEvents([eventWithoutOrgFields], librarySource, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.invalid).toBe(0);

    const insert = findRawEventsInsert();
    expect(insert).toBeDefined();
    const sponsors = JSON.parse(insert![1][6]);
    expect(sponsors[0]).toBe('Oberlin Public Library');
    expect(insert![1]).toEqual(expect.arrayContaining([
      'https://oberlinlibrary.org',
      '440-775-4790',
    ]));
  });

  it('records the run comparison with counts and candidates after a successful run', async () => {
    const result = await persistExtractedEvents([VALID_EVENT], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    const comparisonInsert = findComparisonInsert();
    expect(comparisonInsert).toBeDefined();
    // Parameter layout: [runId, sourceId, status, ..., report].
    expect(comparisonInsert![1][2]).toBe('complete');
    const report = JSON.parse(comparisonInsert![1].at(-1));
    expect(report.counts).toEqual(expect.objectContaining({
      candidates: 1,
      duplicates_preserved: 0,
    }));
    expect(Array.isArray(report.candidates)).toBe(true);
    expect(report.candidates).toHaveLength(1);
  });

  it('still succeeds and records inventory_unavailable when the inventory fetch fails', async () => {
    mockFetch.mockReset().mockRejectedValue(new Error('inventory endpoint unreachable'));

    const result = await persistExtractedEvents([VALID_EVENT], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.duplicates_preserved).toBe(0);
    const comparisonInsert = findComparisonInsert();
    expect(comparisonInsert).toBeDefined();
    expect(comparisonInsert![1][2]).toBe('inventory_unavailable');
    const report = JSON.parse(comparisonInsert![1].at(-1));
    expect(report.inventory_error).toBe('inventory endpoint unreachable');
  });

  it('excludes the corrected original from dedup and skips the inventory fetch on correction runs', async () => {
    const original = {
      id: 99,
      source_id: SOURCE.id,
      status: 'pending_fix',
      title: 'Old Jazz Night',
      description: 'The old event description.',
      event_type: 'ot',
      sponsors: JSON.stringify(['Old Sponsor']),
      post_type_ids: JSON.stringify([8]),
      sessions: JSON.stringify(VALID_EVENT.sessions),
      location_type: 'ne',
    };
    const fixRequest = {
      raw_event_id: 99,
      source_id: SOURCE.id,
      correction_notes: 'Use the corrected session time.',
      sent_by_user_id: 4,
      sent_by_email: 'reviewer@oberlin.edu',
    };
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_runs')) return Promise.resolve([[{ id: 12 }]]);
      if (sql.includes('FROM needs_fix') && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[fixRequest]]);
      }
      if (sql.includes('SELECT * FROM raw_events')) return Promise.resolve([[original]]);
      if (sql.includes('SELECT id FROM raw_events')) return Promise.resolve([[]]);
      if (sql.includes('INSERT INTO raw_events')) return Promise.resolve([{ insertId: 101 }]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents(
      [{ ...VALID_EVENT, fixedFromEventId: 99 }],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );

    expect(result.inserted).toHaveLength(1);
    expect(result.duplicates).toBe(0);

    const dedupCall = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => (
        typeof sql === 'string'
        && sql.includes('SELECT id FROM raw_events')
        && sql.includes('dedup_key')
      ),
    );
    expect(dedupCall).toBeDefined();
    expect(dedupCall![0]).toContain('AND id<>?');
    expect(dedupCall![1]).toEqual([SOURCE.id, expect.any(String), 99]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
