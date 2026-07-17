import {
  attributeRemotePosts,
  buildRunComparisonReport,
  diffCandidateAgainstRemote,
  findCalendarOnlyPosts,
  loadRetainedLocalRows,
  recordRunComparison,
  remotePostSnapshot,
  type CandidatePayloadSnapshot,
  type ComparisonCandidate,
} from '@/lib/runComparison';
import {
  normalizeComparableText,
  type CommunityHubInventory,
  type CommunityHubInventoryPost,
  type CommunityHubInventoryPostRaw,
} from '@/lib/communityHubInventory';

const db = require('@/lib/db');

// Future timestamps so sessions are plausible calendar windows.
const T = 1_900_000_000;
const DAY = 86_400;

type PostInput = {
  name: string;
  eventType?: string;
  description?: string;
  extendedDescription?: string;
  calendarSourceUrl?: string;
  sessions?: Array<{ start: number; end: number }>;
  moderation?: 'approved' | 'pending';
  raw?: Partial<CommunityHubInventoryPostRaw>;
};

// Mirrors how fetchCommunityHubInventory builds posts: normalized comparable
// fields at the top level plus the raw human-readable evidence block.
function makePost(input: PostInput): CommunityHubInventoryPost {
  const sessions = input.sessions ?? [{ start: T, end: T + 3600 }];
  return {
    title: normalizeComparableText(input.name),
    eventType: normalizeComparableText(input.eventType ?? 'ot'),
    description: normalizeComparableText(input.description ?? ''),
    extendedDescription: normalizeComparableText(input.extendedDescription ?? ''),
    calendarSourceUrl: input.calendarSourceUrl ?? '',
    sessions,
    timezone: 'America/New_York',
    moderation: input.moderation ?? 'approved',
    raw: {
      name: input.name,
      description: input.description ?? '',
      extendedDescription: input.extendedDescription ?? '',
      calendarSourceName: '',
      calendarSourceUrl: input.calendarSourceUrl ?? '',
      location: '',
      sponsors: [],
      organizations: [],
      ingestedPostUrl: '',
      hasImage: false,
      ...input.raw,
    },
  };
}

function makePayload(overrides: Partial<CandidatePayloadSnapshot> = {}): CandidatePayloadSnapshot {
  return {
    event_type: 'ot',
    title: 'Local Event',
    description: 'A local event description.',
    extended_description: null,
    sessions: [{ startTime: T, endTime: T + 3600 }],
    sponsors: [],
    post_type_ids: [1],
    location: null,
    calendar_source_url: null,
    buttons: null,
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<ComparisonCandidate> = {},
  payload: Partial<CandidatePayloadSnapshot> = {},
): ComparisonCandidate {
  return {
    index: 0,
    title: 'Local Event',
    outcome: 'inserted',
    event_id: null,
    duplicate_of_event_id: null,
    payload: makePayload(payload),
    communityhub_match: null,
    issues: [],
    adjustments: [],
    ...overrides,
  };
}

function makeInventory(posts: CommunityHubInventoryPost[]): CommunityHubInventory {
  return {
    posts,
    approved: posts.filter(post => post.moderation === 'approved').length,
    pending: posts.filter(post => post.moderation === 'pending').length,
    pages: 1,
    reportedCount: posts.length,
    reportedUnapprovedCount: posts.filter(post => post.moderation === 'pending').length,
  };
}

describe('runComparison', () => {
  beforeEach(() => {
    db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
    db.mockConn.query.mockReset();
    db.mockConn.beginTransaction = jest.fn();
    db.mockConn.commit = jest.fn();
    db.mockConn.rollback = jest.fn();
    db.mockConn.release = jest.fn();
  });

  describe('attributeRemotePosts', () => {
    it('attributes posts by normalized calendar source name, sponsor, or organization', () => {
      const bySourceName = makePost({
        name: 'Story Time',
        raw: { calendarSourceName: 'oberlin  public LIBRARY!!' },
      });
      const bySponsor = makePost({
        name: 'Book Sale',
        raw: { sponsors: ['Something Else', 'Oberlin Public Library'] },
      });
      const byOrganization = makePost({
        name: 'Summer Reading Kickoff',
        raw: { organizations: ['OBERLIN PUBLIC LIBRARY'] },
      });
      const unrelated = makePost({
        name: 'Career Fair',
        raw: { calendarSourceName: 'Career Center' },
      });
      const shortLabel = makePost({
        name: 'Short Label Event',
        raw: { sponsors: ['AB'] },
      });

      const result = attributeRemotePosts(
        [bySourceName, bySponsor, byOrganization, unrelated, shortLabel],
        ['Oberlin Public Library', 'AB'],
      );

      expect(result).toEqual([bySourceName, bySponsor, byOrganization]);
    });

    it('returns nothing when every organization name is shorter than 3 chars after normalization', () => {
      const post = makePost({
        name: 'Story Time',
        raw: { calendarSourceName: 'AB' },
      });
      expect(attributeRemotePosts([post], ['AB', ' ', ''])).toEqual([]);
    });
  });

  describe('diffCandidateAgainstRemote', () => {
    it('treats punctuation and case variants as equal and flags real differences with both values', () => {
      const candidate = makePayload({
        title: 'Coffee, Chat Night!',
        description: 'Join us for coffee.',
        extended_description: 'Local extended details.',
        sessions: [{ startTime: T, endTime: T + 3600 }],
      });
      const remote = makePost({
        name: 'COFFEE & CHAT NIGHT',
        description: 'Join us for coffee.',
        extendedDescription: 'Remote extended details.',
        sessions: [{ start: T + 2 * DAY, end: T + 2 * DAY + 3600 }],
      });

      const diffs = diffCandidateAgainstRemote(candidate, remote);
      const byField = Object.fromEntries(diffs.map(diff => [diff.field, diff]));

      expect(byField.title).toEqual({
        field: 'title',
        local: 'Coffee, Chat Night!',
        remote: 'COFFEE & CHAT NIGHT',
        equal: true,
      });
      expect(byField.description.equal).toBe(true);
      expect(byField.sessions).toEqual({
        field: 'sessions',
        local: `${T}-${T + 3600}`,
        remote: `${T + 2 * DAY}-${T + 2 * DAY + 3600}`,
        equal: false,
      });
      expect(byField.extended_description).toEqual({
        field: 'extended_description',
        local: 'Local extended details.',
        remote: 'Remote extended details.',
        equal: false,
      });
    });
  });

  describe('findCalendarOnlyPosts', () => {
    it('reports attributed posts that match neither candidates nor retained local rows', () => {
      const orgNames = ['Oberlin Public Library'];
      const attributedRaw = { calendarSourceName: 'Oberlin Public Library' };

      // Unique title, unique start time, no session date in the copy, so no
      // exact or probable match against any local row is possible.
      const calendarOnly = makePost({
        name: 'Community Garden Tour',
        description: 'A walking tour of the garden beds.',
        sessions: [{ start: T + 30 * DAY, end: T + 30 * DAY + 3600 }],
        raw: attributedRaw,
      });
      const matchesCandidate = makePost({
        name: 'Local Event!',
        description: 'A local event description.',
        sessions: [{ start: T, end: T + 3600 }],
        raw: attributedRaw,
      });
      const matchesRetained = makePost({
        name: 'Retained Concert',
        description: 'An evening concert.',
        sessions: [{ start: T + 7 * DAY, end: T + 7 * DAY + 3600 }],
        raw: attributedRaw,
      });

      const candidates = [makeCandidate()];
      const retainedLocalRows = [{
        title: 'Retained Concert',
        event_type: 'ot',
        description: 'An evening concert.',
        extended_description: null,
        calendar_source_url: null,
        sessions: JSON.stringify([{ startTime: T + 7 * DAY, endTime: T + 7 * DAY + 3600 }]),
      }];

      const result = findCalendarOnlyPosts(
        makeInventory([calendarOnly, matchesCandidate, matchesRetained]),
        orgNames,
        candidates,
        retainedLocalRows,
      );

      expect(result).toEqual([calendarOnly]);
    });
  });

  describe('buildRunComparisonReport', () => {
    it('counts matched, integration-only, calendar-only, and preserved duplicates', () => {
      const attributedRaw = { calendarSourceName: 'Oberlin Public Library' };
      const remoteMatch = makePost({
        name: 'Local Event!',
        description: 'A local event description.',
        sessions: [{ start: T, end: T + 3600 }],
        raw: attributedRaw,
      });
      const calendarOnly = makePost({
        name: 'Community Garden Tour',
        description: 'A walking tour of the garden beds.',
        sessions: [{ start: T + 30 * DAY, end: T + 30 * DAY + 3600 }],
        raw: attributedRaw,
      });

      const matched = makeCandidate({
        index: 0,
        outcome: 'duplicate_communityhub',
        communityhub_match: {
          kind: 'exact',
          reasons: ['normalized title', 'complete session windows'],
          field_diffs: diffCandidateAgainstRemote(makePayload(), remoteMatch),
          remote: remotePostSnapshot(remoteMatch),
        },
      });
      const crossSource = makeCandidate(
        { index: 1, title: 'Cross Source Event', outcome: 'duplicate_cross_source' },
        {
          title: 'Cross Source Event',
          description: 'Cross source description.',
          sessions: [{ startTime: T + 14 * DAY, endTime: T + 14 * DAY + 3600 }],
        },
      );
      const inserted = makeCandidate(
        { index: 2, title: 'Fresh Event', outcome: 'inserted', event_id: 55 },
        {
          title: 'Fresh Event',
          description: 'Fresh event description.',
          sessions: [{ startTime: T + 21 * DAY, endTime: T + 21 * DAY + 3600 }],
        },
      );

      const report = buildRunComparisonReport({
        organizationNames: ['Oberlin Public Library', ''],
        candidates: [matched, crossSource, inserted],
        inventory: makeInventory([remoteMatch, calendarOnly]),
        inventoryError: null,
        retainedLocalRows: [],
      });

      expect(report.source_names_used).toEqual(['Oberlin Public Library']);
      expect(report.counts).toEqual({
        candidates: 3,
        matched_both: 1,
        integration_only: 2,
        calendar_only: 1,
        duplicates_preserved: 2,
      });
      expect(report.calendar_only).toEqual([remotePostSnapshot(calendarOnly)]);
      expect(report.inventory_error).toBeNull();
    });

    it('records the inventory error and leaves calendar_only empty when inventory is null', () => {
      const report = buildRunComparisonReport({
        organizationNames: ['Oberlin Public Library'],
        candidates: [makeCandidate()],
        inventory: null,
        inventoryError: 'CommunityHub inventory returned HTTP 500',
        retainedLocalRows: [],
      });

      expect(report.calendar_only).toEqual([]);
      expect(report.counts).toEqual({
        candidates: 1,
        matched_both: 0,
        integration_only: 1,
        calendar_only: 0,
        duplicates_preserved: 0,
      });
      expect(report.inventory_error).toBe('CommunityHub inventory returned HTTP 500');
    });
  });

  describe('recordRunComparison', () => {
    it('upserts the run comparison row with the JSON report', async () => {
      const post = makePost({
        name: 'Local Event!',
        moderation: 'pending',
        raw: { calendarSourceName: 'Oberlin Public Library' },
      });
      const report = buildRunComparisonReport({
        organizationNames: ['Oberlin Public Library'],
        candidates: [makeCandidate({ outcome: 'duplicate_communityhub' })],
        inventory: makeInventory([post]),
        inventoryError: null,
        retainedLocalRows: [],
      });

      await recordRunComparison({
        runId: 42,
        sourceId: 7,
        report,
        inventory: makeInventory([post]),
        inventorySha256: 'abc123',
      });

      expect(db.default.query).toHaveBeenCalledTimes(1);
      const [sql, params] = db.default.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO integration_run_comparisons');
      expect(sql).toContain('ON DUPLICATE KEY UPDATE');
      expect(params.slice(0, 10)).toEqual([
        42,
        7,
        'complete',
        'abc123',
        0,
        1,
        report.counts.matched_both,
        report.counts.integration_only,
        report.counts.calendar_only,
        report.counts.duplicates_preserved,
      ]);
      expect(JSON.parse(params[10])).toEqual(report);
    });

    it('marks the run as inventory_unavailable when there is no inventory', async () => {
      const report = buildRunComparisonReport({
        organizationNames: ['Oberlin Public Library'],
        candidates: [],
        inventory: null,
        inventoryError: 'timeout',
        retainedLocalRows: [],
      });

      await recordRunComparison({
        runId: 43,
        sourceId: 7,
        report,
        inventory: null,
        inventorySha256: null,
      });

      const [, params] = db.default.query.mock.calls[0];
      expect(params.slice(0, 6)).toEqual([43, 7, 'inventory_unavailable', null, 0, 0]);
    });
  });

  describe('loadRetainedLocalRows', () => {
    it('selects retained rows for the source and returns them', async () => {
      const row = {
        title: 'Retained Concert',
        event_type: 'ot',
        description: 'An evening concert.',
        extended_description: null,
        calendar_source_url: null,
        sessions: '[]',
      };
      db.default.query.mockResolvedValueOnce([[row]]);

      const rows = await loadRetainedLocalRows(7);

      expect(rows).toEqual([row]);
      const [sql, params] = db.default.query.mock.calls[0];
      expect(sql).toContain('FROM raw_events');
      expect(sql).toContain('source_id=?');
      expect(params).toEqual([7]);
    });

    it('returns an empty list when the driver yields a non-array result', async () => {
      db.default.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
      await expect(loadRetainedLocalRows(7)).resolves.toEqual([]);
    });
  });
});
