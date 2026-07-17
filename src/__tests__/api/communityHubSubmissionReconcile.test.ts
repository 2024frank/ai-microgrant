import { NextRequest } from 'next/server';
import { DELETE, POST } from '@/app/api/communityhub/submissions/[id]/reconcile/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockFetch = jest.fn();
global.fetch = mockFetch;

const ADMIN = {
  id: 1,
  email: 'admin@oberlin.edu',
  role: 'admin',
  full_name: 'Admin',
  active: 1,
  firebase_uid: 'uid-admin',
  can_review_all_sources: 0,
};
const SUBMISSION = {
  id: 7,
  raw_event_id: 42,
  status: 'sending',
  title: 'Community Event',
};
const context = { params: Promise.resolve({ id: '7' }) };

function request(postId = '5101') {
  return new NextRequest('http://localhost/api/communityhub/submissions/7/reconcile', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ communityhub_post_id: postId }),
  });
}

function communityHubResponse(ingestedPostUrl: string) {
  return new Response(JSON.stringify({
    post: { id: 5101, approved: null, ingestedPostUrl },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockVerify.mockReset().mockResolvedValue({ uid: ADMIN.firebase_uid, email: ADMIN.email });
  db.default.query
    .mockReset()
    .mockResolvedValueOnce([[ADMIN]])
    .mockResolvedValueOnce([[SUBMISSION]]);
  db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset().mockImplementation((sql: string) => {
    if (sql.includes('SELECT cs.status')) {
      return Promise.resolve([[
        { status: 'sending', event_status: 'publishing', current_post_id: null },
      ]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockFetch.mockReset();
});

it.each([
  'https://intake.example/events/42',
  'https://intake.example/reviewer/events/42/',
])('links a verified CommunityHub post using supported intake URL %s', async ingestedPostUrl => {
  mockFetch.mockResolvedValueOnce(communityHubResponse(ingestedPostUrl));

  const response = await POST(request(), context);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    status: 'submitted',
    communityhub_post_id: '5101',
  });
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE id=? AND status='publishing'"),
    ['5101', SUBMISSION.raw_event_id],
  );
  expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
});

it('rejects a post whose deep link belongs to a different intake record', async () => {
  mockFetch.mockResolvedValueOnce(communityHubResponse('https://intake.example/reviewer/events/43'));

  const response = await POST(request(), context);

  expect(response.status).toBe(409);
  expect(db.default.getConnection).not.toHaveBeenCalled();
});

it('does not overwrite an intake record that changed before reconciliation', async () => {
  mockFetch.mockResolvedValueOnce(communityHubResponse('https://intake.example/reviewer/events/42'));
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('SELECT cs.status')) {
      return Promise.resolve([[
        { status: 'sending', event_status: 'rejected', current_post_id: null },
      ]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });

  const response = await POST(request(), context);

  expect(response.status).toBe(409);
  expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
  expect(db.mockConn.commit).not.toHaveBeenCalled();
  expect(db.mockConn.query.mock.calls.some(
    ([sql]: [string]) => sql.includes("SET status='succeeded'"),
  )).toBe(false);
});

it('releases an old ambiguous send only after explicit external no-post confirmation', async () => {
  db.default.query.mockReset().mockResolvedValueOnce([[ADMIN]]);
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('TIMESTAMPDIFF')) {
      return Promise.resolve([[
        {
          status: 'sending',
          raw_event_id: SUBMISSION.raw_event_id,
          age_seconds: 900,
          event_status: 'publishing',
        },
      ]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  const releaseRequest = new NextRequest(
    'http://localhost/api/communityhub/submissions/7/reconcile',
    {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'NO_COMMUNITYHUB_POST_EXISTS' }),
    },
  );

  const response = await DELETE(releaseRequest, context);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, safe_to_retry: true, status: 'pending' });
  expect(db.mockConn.query).toHaveBeenCalledWith(
    expect.stringContaining("WHERE id=? AND status='sending'"),
    [expect.stringContaining(ADMIN.email), SUBMISSION.id],
  );
  expect(db.mockConn.commit).toHaveBeenCalled();
});

it('refuses to release an ambiguous send before the ten-minute safety window', async () => {
  db.default.query.mockReset().mockResolvedValueOnce([[ADMIN]]);
  db.mockConn.query.mockImplementation((sql: string) => {
    if (sql.includes('TIMESTAMPDIFF')) {
      return Promise.resolve([[
        {
          status: 'sending',
          raw_event_id: SUBMISSION.raw_event_id,
          age_seconds: 60,
          event_status: 'publishing',
        },
      ]]);
    }
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  const releaseRequest = new NextRequest(
    'http://localhost/api/communityhub/submissions/7/reconcile',
    {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'NO_COMMUNITYHUB_POST_EXISTS' }),
    },
  );

  const response = await DELETE(releaseRequest, context);

  expect(response.status).toBe(409);
  expect(db.mockConn.rollback).toHaveBeenCalled();
  expect(db.mockConn.commit).not.toHaveBeenCalled();
});
