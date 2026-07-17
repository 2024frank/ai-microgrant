import { reconcileCommunityHubContent } from '@/lib/communityHubContentReconciliation';

const db = require('@/lib/db');

const NOW_FUTURE = 1_900_000_000;

function inventoryFetcher(posts: Record<string, unknown>[]) {
  return jest.fn(async () => new Response(JSON.stringify({
    count: posts.length,
    unapprovedRecordsCount: posts.filter(post => post.approved === null).length,
    lastPage: true,
    posts,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

function localRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    source_id: 2,
    source_name: 'Example Source',
    title: 'Local Event',
    event_type: 'ot',
    description: 'A local event description.',
    extended_description: null,
    calendar_source_url: 'https://example.org/local',
    sessions: JSON.stringify([{ startTime: NOW_FUTURE, endTime: NOW_FUTURE + 3600 }]),
    dedup_key: 'dedup',
    status: 'submitted',
    communityhub_moderation_status: 'pending',
    updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('CommunityHub content reconciliation', () => {
  beforeEach(() => {
    db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
    db.mockConn.query.mockReset();
    db.mockConn.beginTransaction.mockReset().mockResolvedValue(undefined);
    db.mockConn.commit.mockReset().mockResolvedValue(undefined);
    db.mockConn.rollback.mockReset().mockResolvedValue(undefined);
    db.mockConn.release.mockReset();
  });

  it('plans against complete content while parsing stored JSON session strings', async () => {
    const exact = localRow({
      id: 11,
      title: 'Exact Event',
      description: 'Exact event description.',
      calendar_source_url: 'https://example.org/exact',
    });
    const absent = localRow({ id: 12 });
    const expired = localRow({
      id: 13,
      sessions: JSON.stringify([{ startTime: 1_700_000_000, endTime: 1_700_003_600 }]),
    });
    db.mockConn.query.mockResolvedValueOnce([[exact, absent, expired]]);

    const result = await reconcileCommunityHubContent({
      fetcher: inventoryFetcher([{
        name: 'Exact Event',
        approved: true,
        eventType: 'ot',
        description: 'Exact event description.',
        calendarSourceUrl: 'https://example.org/exact',
        sessions: [{ start: NOW_FUTURE, end: NOW_FUTURE + 3600 }],
      }]),
    });

    expect(result).toMatchObject({
      mode: 'dry-run',
      candidate_rows: 3,
      expired_or_invalid_session_rows: 1,
      eligible_waiting_rows: 2,
      exact_matches: 1,
      proven_absent: 1,
      deleted: 0,
    });
    expect(result.reports.map(report => [report.local.event_id, report.match.kind])).toEqual([
      [11, 'exact'],
      [12, 'none'],
    ]);
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('rechecks eligibility and content under lock before an audited deletion', async () => {
    const absent = localRow({ image_data: Buffer.from('poster') });
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT re.id, re.source_id')) return Promise.resolve([[absent]]);
      if (sql.includes('GET_LOCK')) return Promise.resolve([[{ acquired: 1 }]]);
      if (sql.includes('SELECT re.*, s.name AS source_name')) return Promise.resolve([[absent]]);
      if (sql.includes('SELECT * FROM')) return Promise.resolve([[]]);
      if (sql.includes('DELETE FROM raw_events')) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await reconcileCommunityHubContent({
      apply: true,
      fetcher: inventoryFetcher([{
        name: 'Different Remote Event',
        approved: null,
        eventType: 'ot',
        description: 'Unrelated content.',
        sessions: [{ start: NOW_FUTURE + 86_400, end: NOW_FUTURE + 90_000 }],
      }]),
    });

    expect(result).toMatchObject({
      mode: 'apply',
      proven_absent: 1,
      deleted: 1,
      deleted_event_ids: [10],
    });
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
    const archive = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO communityhub_reconciliation_deletions'),
    );
    expect(archive?.[1]?.[5]).toContain('omitted_binary');
    const lockedRead = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('SELECT re.*, s.name AS source_name'),
    );
    expect(lockedRead?.[0]).toContain("communityhub_updates");
    expect(lockedRead?.[0]).toContain('FOR UPDATE');
  });
});
