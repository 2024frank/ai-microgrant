import {
  CommunityHubUpdateConflictError,
  deliverCommunityHubUpdate,
  finalizeCommunityHubUpdate,
  prepareCommunityHubUpdate,
  reconcilePendingCommunityHubUpdates,
} from '@/lib/communityHubUpdates';

const db = require('@/lib/db');
const mockFetch = jest.fn();
global.fetch = mockFetch;

const DRAFT = {
  rawEventId: 10,
  sourceId: 1,
  communityHubPostId: '5101',
  originalStatus: 'approved' as const,
  chEdits: { title: 'Corrected title' },
  localEdits: { title: 'Corrected title' },
  auditEntries: [{ field: 'title', oldValue: 'Old title', newValue: 'Corrected title' }],
  reviewerId: 2,
};

const OUTBOX_ROW = {
  id: 31,
  raw_event_id: 10,
  communityhub_post_id: '5101',
  original_status: 'approved',
  status: 'ambiguous',
  ch_edits: JSON.stringify(DRAFT.chEdits),
  local_edits: JSON.stringify(DRAFT.localEdits),
  audit_entries: JSON.stringify(DRAFT.auditEntries),
  reviewer_id: 2,
};

beforeEach(() => {
  db.default.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockFetch.mockReset();
});

it('durably claims the event and stores both sides of an edit before networking', async () => {
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('UPDATE raw_events')) return Promise.resolve([{ affectedRows: 1 }]);
    if (sql.includes('INSERT INTO communityhub_updates')) return Promise.resolve([{ insertId: 31 }]);
    return Promise.resolve([{ affectedRows: 1 }]);
  });

  const prepared = await prepareCommunityHubUpdate(DRAFT);

  expect(prepared.id).toBe(31);
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("SET status='submitted'"),
    [10, '5101', 'approved'],
  );
  const insert = db.mockConn.query.mock.calls.find(
    ([sql]: [string]) => sql.includes('INSERT INTO communityhub_updates'),
  );
  expect(insert[1]).toEqual(expect.arrayContaining([
    JSON.stringify(DRAFT.chEdits),
    JSON.stringify(DRAFT.localEdits),
    JSON.stringify(DRAFT.auditEntries),
  ]));
  expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('rolls back when another workflow already owns the event', async () => {
  db.mockConn.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

  await expect(prepareCommunityHubUpdate(DRAFT)).rejects.toBeInstanceOf(
    CommunityHubUpdateConflictError,
  );
  expect(db.mockConn.rollback).toHaveBeenCalled();
});

it('atomically applies stored local edits and marks the outbox succeeded', async () => {
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('FROM communityhub_updates') && sql.includes('FOR UPDATE')) {
      return Promise.resolve([[OUTBOX_ROW]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });

  await finalizeCommunityHubUpdate(31, { post: { id: 5101, approved: null } });

  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("status='submitted'"),
    ['Corrected title', 10, '5101'],
  );
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO field_edit_log'),
    [2, 'title', 'Old title', 'Corrected title', 10],
  );
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringMatching(/SET status='succeeded'[\s\S]*JSON_REMOVE\(local_edits, '\$\.image_data'\)/),
    [JSON.stringify({ post: { id: 5101, approved: null } }), 31],
  );
  expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
});

it('keeps a timeout replayable without exposing the event as approved', async () => {
  mockFetch.mockRejectedValueOnce(new Error('timeout'));

  const result = await deliverCommunityHubUpdate(31, 10, '5101', DRAFT.chEdits);

  expect(result).toMatchObject({ status: 'ambiguous', error: 'timeout' });
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining("status='ambiguous'"),
    ['timeout', 31],
  );
});

it('replays an ambiguous idempotent PATCH and finishes the stored local edit', async () => {
  db.default.query.mockResolvedValueOnce([[
    {
      id: 31,
      raw_event_id: 10,
      communityhub_post_id: '5101',
      ch_edits: JSON.stringify(DRAFT.chEdits),
    },
  ]]);
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('FROM communityhub_updates') && sql.includes('FOR UPDATE')) {
      return Promise.resolve([[OUTBOX_ROW]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
    post: { id: 5101, approved: null },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  const results = await reconcilePendingCommunityHubUpdates();

  expect(results).toEqual([expect.objectContaining({ status: 'succeeded', update_id: 31 })]);
  expect(mockFetch).toHaveBeenCalledWith(
    'https://oberlin.communityhub.cloud/api/legacy/calendar/post/5101/submit',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify(DRAFT.chEdits) }),
  );
  expect(db.mockConn.commit).toHaveBeenCalled();
  expect(db.default.query.mock.calls[0][0]).toContain(
    "updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)",
  );
});

it('does not restore public state when an ambiguous replay later gets a permanent 4xx', async () => {
  db.default.query.mockResolvedValueOnce([[
    {
      id: 31,
      raw_event_id: 10,
      communityhub_post_id: '5101',
      ch_edits: JSON.stringify(DRAFT.chEdits),
    },
  ]]);
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'state changed' }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  }));

  const results = await reconcilePendingCommunityHubUpdates();

  expect(results[0]).toMatchObject({ status: 'ambiguous' });
  expect(results[0].error).toContain('later permanent response is not rollback proof');
  expect(db.default.query).toHaveBeenCalledWith(
    expect.stringContaining("SET status='ambiguous'"),
    [expect.stringContaining('later permanent response is not rollback proof'), 31],
  );
  expect(db.default.getConnection).not.toHaveBeenCalled();
});

it('restores the original state only for a definitive first-attempt client rejection', async () => {
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('FROM communityhub_updates') && sql.includes('FOR UPDATE')) {
      return Promise.resolve([[{ ...OUTBOX_ROW, status: 'sending' }]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid edit' }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  }));

  const result = await deliverCommunityHubUpdate(
    31,
    10,
    '5101',
    DRAFT.chEdits,
    { rollbackOnPermanentFailure: true },
  );

  expect(result).toMatchObject({ status: 'failed', response_status: 422 });
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining('SET status=?, communityhub_moderation_status=?'),
    ['approved', 'approved', expect.stringContaining('CommunityHub 422'), 10],
  );
});

it('keeps a remotely missing post hidden instead of restoring approved state', async () => {
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('FROM communityhub_updates') && sql.includes('FOR UPDATE')) {
      return Promise.resolve([[{ ...OUTBOX_ROW, status: 'sending' }]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));

  const result = await deliverCommunityHubUpdate(
    31,
    10,
    '5101',
    DRAFT.chEdits,
    { rollbackOnPermanentFailure: true },
  );

  expect(result).toMatchObject({ status: 'failed', response_status: 404 });
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("communityhub_moderation_status='missing'"),
    [expect.stringContaining('CommunityHub 404'), 10],
  );
  expect(db.mockConn.query.mock.calls.some(
    ([sql]: [string]) => sql.includes('SET status=?'),
  )).toBe(false);
});
