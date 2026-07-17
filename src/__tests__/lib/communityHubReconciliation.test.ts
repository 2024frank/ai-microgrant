import { reconcileCommunityHub } from '@/lib/communityHubReconciliation';

const db = require('@/lib/db');
const mockFetch = jest.fn();
global.fetch = mockFetch;

const CANDIDATE = {
  id: 158,
  source_id: 7,
  status: 'submitted',
  communityhub_post_id: '5101',
  event_type: 'ot',
  title: "The Howlin' Brothers",
  description: 'Roots music at Riverdog.',
  extended_description: null,
  sponsors: JSON.stringify(['Riverdog Music']),
  post_type_ids: JSON.stringify([8]),
  sessions: JSON.stringify([{ startTime: 1_792_884_600, endTime: 1_792_893_600 }]),
  location_type: 'ph2',
  location: 'Henrietta Township, OH',
  place_id: null,
  place_name: 'Riverdog',
  room_num: null,
  url_link: '',
  display: 'all',
  screen_ids: '[]',
  buttons: '[]',
  contact_email: 'riverdog@example.org',
  phone: null,
  website: 'https://example.org',
  calendar_source_name: 'Riverdog Music',
  calendar_source_url: 'https://example.org/shows',
  ingested_post_url: 'https://app.example/reviewer/events/158',
};
let candidate = CANDIDATE;

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
  candidate = CANDIDATE;
  db.mockConn.query.mockReset().mockImplementation((sql: string) => {
    if (sql.includes('GET_LOCK')) return Promise.resolve([[{ acquired: 1 }]]);
    if (sql.includes('COUNT(*) AS unchecked')) return Promise.resolve([[{ unchecked: 0 }]]);
    if (sql.includes('SELECT id, source_id, status, communityhub_post_id')) {
      if (sql.includes("status='approved'") && candidate.status === 'approved') {
        return Promise.resolve([[candidate]]);
      }
      if (sql.includes("status='submitted'") && candidate.status === 'submitted') {
        return Promise.resolve([[candidate]]);
      }
      return Promise.resolve([[]]);
    }
    if (sql.includes('SELECT id, status FROM raw_events')) {
      return Promise.resolve([[{ id: candidate.id, status: candidate.status }]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
});

it('keeps an externally pending submission out of the published state', async () => {
  mockFetch.mockResolvedValue(response(200, {
    post: { id: 5101, approved: null, eventType: 'ot', rejections: [] },
  }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ checked: 1, pending: 1, approved: 0, failed: 0 });
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringMatching(/UPDATE raw_events[\s\S]*status IN \('approved','resubmitted'\)[\s\S]*communityhub_moderation_status='unknown'/),
  );
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_status'),
    ['submitted', 'pending', null, 'submitted', 'submitted', CANDIDATE.id, 'submitted'],
  );
});

it('publishes only after CommunityHub returns approved=true', async () => {
  mockFetch.mockResolvedValue(response(200, {
    post: { id: 5101, approved: true, eventType: 'ot' },
  }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result.approved).toBe(1);
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_status'),
    ['approved', 'approved', null, 'approved', 'submitted', CANDIDATE.id, 'submitted'],
  );
  const approvedPoll = db.mockConn.query.mock.calls.find(
    ([sql]: [string]) => sql.includes("status='approved' AND communityhub_moderation_status='approved'"),
  );
  expect(approvedPoll?.[1]).toEqual([5]);
});

it('moves a CommunityHub rejection into the existing correction flow idempotently', async () => {
  mockFetch.mockResolvedValue(response(200, {
    post: {
      id: 5101,
      approved: false,
      eventType: 'ot',
      rejections: [{ id: 513, reason: '' }],
    },
  }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result.rejected).toBe(1);
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("status='rejected'"),
    [CANDIDATE.id, 'submitted'],
  );
  const rejectionInsert = db.mockConn.query.mock.calls.find(
    ([sql]: [string]) => sql.includes('INSERT IGNORE INTO rejection_log'),
  );
  expect(rejectionInsert).toBeDefined();
  expect(rejectionInsert[1]).toEqual(expect.arrayContaining([
    JSON.stringify(['communityhub_rejected']),
    'CommunityHub rejected this submission without providing a reason.',
    'communityhub:5101:513',
  ]));
  expect(db.mockConn.commit).toHaveBeenCalled();
});

it('marks a missing CommunityHub post for attention and never resubmits it', async () => {
  mockFetch.mockResolvedValue(response(404, { error: 'not found' }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ missing: 1, approved: 0, rejected: 0 });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_status'),
    [
      'submitted', 'missing', 'CommunityHub returned 404 for this post id',
      'submitted', 'submitted', CANDIDATE.id, 'submitted',
    ],
  );
});

it('repairs the known invalid legacy event type while a post is pending', async () => {
  mockFetch
    .mockResolvedValueOnce(response(200, {
      post: { id: 5101, approved: null, eventType: 'ev' },
    }))
    .mockResolvedValueOnce(response(200, { post: { id: 5101 } }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ pending: 1, repaired: 1, failed: 0 });
  expect(mockFetch.mock.calls[1][1]).toEqual(expect.objectContaining({
    method: 'PATCH',
    body: JSON.stringify({ eventType: 'ot' }),
  }));
});

it('preserves an unknown state after a network failure so a later run can retry', async () => {
  mockFetch.mockRejectedValue(new Error('timeout'));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ unknown: 1, failed: 1 });
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_status'),
    ['submitted', 'unknown', 'timeout', 'submitted', 'submitted', CANDIDATE.id, 'submitted'],
  );
});

it('withdraws a previously approved post when CommunityHub later rejects it', async () => {
  candidate = { ...CANDIDATE, status: 'approved' };
  mockFetch.mockResolvedValue(response(200, {
    post: {
      id: 5101,
      approved: false,
      eventType: 'ot',
      rejections: [{ id: 9001, reason: 'Incorrect details' }],
    },
  }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result.rejected).toBe(1);
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("status='rejected'"),
    [CANDIDATE.id, 'approved'],
  );
});

it('withdraws a previously approved post when CommunityHub deletes it', async () => {
  candidate = { ...CANDIDATE, status: 'approved' };
  mockFetch.mockResolvedValue(response(404, { error: 'not found' }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result.missing).toBe(1);
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_status'),
    [
      'submitted', 'missing', 'CommunityHub returned 404 for this post id',
      'submitted', 'approved', CANDIDATE.id, 'approved',
    ],
  );
});

it('preserves last-known approval through a transient CommunityHub outage', async () => {
  candidate = { ...CANDIDATE, status: 'approved' };
  mockFetch.mockRejectedValue(new Error('timeout'));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ unknown: 1, failed: 1 });
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_status'),
    ['approved', 'approved', 'timeout', 'approved', 'approved', CANDIDATE.id, 'approved'],
  );
});

it('records category drift when the live post displays other categories than submitted', async () => {
  mockFetch.mockResolvedValue(response(200, {
    post: {
      id: 5101,
      approved: null,
      eventType: 'ot',
      postType: [{ id: 11, name: 'Spectator Sport' }],
      rejections: [],
    },
  }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ checked: 1, pending: 1, category_drift: 1, failed: 0 });
  const item = result.results.find(r => r.event_id === CANDIDATE.id);
  expect(item?.category_drift).toContain('[11]');
  expect(item?.category_drift).toContain('[8]');

  // The drift text is stored on the row via communityhub_moderation_error.
  const stateUpdate = db.default.query.mock.calls.find(
    ([sql]: [string]) => typeof sql === 'string' && sql.includes('communityhub_moderation_error'),
  );
  expect(stateUpdate).toBeDefined();
  expect(stateUpdate[1]).toEqual([
    'submitted', 'pending', item?.category_drift,
    'submitted', 'submitted', CANDIDATE.id, 'submitted',
  ]);
});

it('reports no category drift when the live post matches the submitted categories', async () => {
  mockFetch.mockResolvedValue(response(200, {
    post: {
      id: 5101,
      approved: null,
      eventType: 'ot',
      postType: [{ id: 8, name: 'Music Performance' }],
      rejections: [],
    },
  }));

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ checked: 1, pending: 1, category_drift: 0 });
  expect(result.results[0].category_drift).toBeUndefined();
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining('communityhub_moderation_error'),
    ['submitted', 'pending', null, 'submitted', 'submitted', CANDIDATE.id, 'submitted'],
  );
});

it('skips duplicate cron invocations while another reconciliation owns the lock', async () => {
  db.mockConn.query.mockResolvedValueOnce([[{ acquired: 0 }]]);

  const result = await reconcileCommunityHub({ force: true });

  expect(result).toMatchObject({ checked: 0, skipped_locked: true });
  expect(mockFetch).not.toHaveBeenCalled();
});
