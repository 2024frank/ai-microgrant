import { resolveUnresolvedCommunityHubSubmissions } from '@/lib/communityHubSubmissions';

const db = require('@/lib/db');

const NOW = Math.floor(Date.now() / 1000);
const FUTURE_START = NOW + 7 * 24 * 3600;
const FUTURE_END = FUTURE_START + 7200;

function storedPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    eventType: 'ot',
    title: '2026 Gregg Gilder Memorial Firewalk',
    description: 'Walk across the coals to support the community center.',
    extendedDescription: '',
    calendarSourceUrl: 'https://commongroundcenter.org/firewalk',
    sessions: [{ startTime: FUTURE_START, endTime: FUTURE_END }],
    ...overrides,
  });
}

function inventoryPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 987,
    name: '2026 Gregg Gilder Memorial Firewalk',
    eventType: 'ot',
    description: 'Walk across the coals to support the community center.',
    extendedDescription: '',
    calendarSourceUrl: 'https://commongroundcenter.org/firewalk',
    sessions: [{ startTime: FUTURE_START, endTime: FUTURE_END }],
    approved: null, // pending moderation
    ...overrides,
  };
}

function unrelatedPost() {
  return inventoryPost({
    id: 555,
    name: 'Pottery Workshop Series',
    description: 'Hand building pottery for beginners at the studio.',
    calendarSourceUrl: 'https://studio.example.org/pottery',
    sessions: [{ startTime: FUTURE_START + 90_000, endTime: FUTURE_END + 90_000 }],
    approved: true,
  });
}

function inventoryFetcher(posts: Record<string, unknown>[]) {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      posts,
      lastPage: true,
      count: posts.length,
      unapprovedRecordsCount: posts.filter(post => post.approved === null).length,
    }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  // setup.ts never clears call history between files; count from zero here.
  db.default.getConnection.mockClear().mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
});

describe('resolveUnresolvedCommunityHubSubmissions', () => {
  it('links a submission whose content provably exists on the calendar', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 31, raw_event_id: 172, payload: storedPayload() },
    ]]);
    // recoverSucceededCommunityHubSubmission reads the succeeded row back.
    db.mockConn.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes("status='succeeded'")
        && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[{
          id: 31, communityhub_post_id: '987', response: '{}', reviewer_id: null,
        }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const results = await resolveUnresolvedCommunityHubSubmissions(
      10,
      inventoryFetcher([inventoryPost(), unrelatedPost()]),
    );

    expect(results).toEqual([
      expect.objectContaining({ submission_id: 31, event_id: 172, outcome: 'linked', post_id: '987' }),
    ]);
    const claim = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET status='succeeded'"),
    );
    expect(claim![1]).toEqual(['987', 31]);
  });

  it('releases a submission whose content is provably absent', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 32, raw_event_id: 180, payload: storedPayload() },
    ]]);

    const results = await resolveUnresolvedCommunityHubSubmissions(
      10,
      inventoryFetcher([unrelatedPost()]),
    );

    expect(results).toEqual([
      expect.objectContaining({ submission_id: 32, event_id: 180, outcome: 'released' }),
    ]);
    const failed = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET status='failed'"),
    );
    expect(String(failed![0])).toContain('Auto-verified');
    const release = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string'
        && sql.includes("SET status='pending'") && sql.includes("status='publishing'"),
    );
    expect(release![1]).toEqual([180]);
  });

  it('leaves a probable match for the operator', async () => {
    db.default.query.mockResolvedValueOnce([[
      { id: 33, raw_event_id: 181, payload: storedPayload() },
    ]]);
    // Same title and source URL but a different session window: probable.
    const results = await resolveUnresolvedCommunityHubSubmissions(
      10,
      inventoryFetcher([inventoryPost({
        sessions: [{ startTime: FUTURE_START + 3600, endTime: FUTURE_END + 3600 }],
      })]),
    );

    expect(results).toEqual([
      expect.objectContaining({ submission_id: 33, outcome: 'left_manual' }),
    ]);
    expect(db.default.getConnection).not.toHaveBeenCalled();
  });

  it('skips a submission whose payload sessions have already ended', async () => {
    db.default.query.mockResolvedValueOnce([[
      {
        id: 34,
        raw_event_id: 182,
        payload: storedPayload({
          sessions: [{ startTime: NOW - 7200, endTime: NOW - 3600 }],
        }),
      },
    ]]);

    const results = await resolveUnresolvedCommunityHubSubmissions(
      10,
      inventoryFetcher([unrelatedPost()]),
    );

    expect(results).toEqual([
      expect.objectContaining({ submission_id: 34, outcome: 'skipped_expired' }),
    ]);
  });

  it('returns nothing without touching the network when no submission is stuck', async () => {
    db.default.query.mockResolvedValueOnce([[]]);
    const fetcher = inventoryFetcher([unrelatedPost()]);
    const results = await resolveUnresolvedCommunityHubSubmissions(10, fetcher);
    expect(results).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
