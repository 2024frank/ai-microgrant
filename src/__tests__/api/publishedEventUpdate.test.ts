const mockPrepareUpdate = jest.fn();
const mockDeliverUpdate = jest.fn();
const NORMALIZED_IMAGE = 'data:image/jpeg;base64,/9j/2Q==';

jest.mock('@/lib/communityHubUpdates', () => ({
  CommunityHubUpdateConflictError: class CommunityHubUpdateConflictError extends Error {},
  prepareCommunityHubUpdate: mockPrepareUpdate,
  deliverCommunityHubUpdate: mockDeliverUpdate,
}));

jest.mock('@/lib/safeRemoteImage', () => ({
  normalizeEmbeddedImageData: jest.fn().mockResolvedValue('data:image/jpeg;base64,/9j/2Q=='),
}));

import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/events/[id]/route';
import { adminAuth } from '@/lib/firebase-admin';
import { normalizeEmbeddedImageData } from '@/lib/safeRemoteImage';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockNormalizeImage = normalizeEmbeddedImageData as jest.Mock;

const ADMIN = {
  id: 1,
  email: 'admin@oberlin.edu',
  role: 'admin',
  full_name: 'Admin',
  active: 1,
  firebase_uid: 'uid-admin',
  can_review_all_sources: 0,
};
const APPROVED_EVENT = {
  id: 10,
  source_id: 1,
  status: 'approved',
  communityhub_moderation_status: 'approved',
  communityhub_post_id: '5101',
  event_type: 'ot',
  title: 'Original Community Event',
  description: 'A documented public community event.',
  extended_description: null,
  sponsors: JSON.stringify(['Community Partner']),
  post_type_ids: JSON.stringify([8]),
  sessions: JSON.stringify([{ startTime: 4_102_444_800, endTime: 4_102_448_400 }]),
  location_type: 'ph2',
  location: '39 South Main Street, Oberlin, OH',
  place_id: null,
  place_name: 'Community Hall',
  room_num: null,
  url_link: null,
  display: 'all',
  screen_ids: JSON.stringify([]),
  buttons: JSON.stringify([]),
  contact_email: null,
  phone: null,
  website: 'https://example.org/event',
  image_cdn_url: null,
  image_data: null,
  calendar_source_name: 'Community Partner',
  calendar_source_url: 'https://example.org/events',
  ingested_post_url: 'https://intake.example/reviewer/events/10',
};
const context = { params: Promise.resolve({ id: '10' }) };

function request(edits: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/events/10', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer valid',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ edits }),
  });
}

beforeEach(() => {
  mockVerify.mockReset().mockResolvedValue({ uid: ADMIN.firebase_uid, email: ADMIN.email });
  db.default.query
    .mockReset()
    .mockResolvedValue([{ affectedRows: 1 }])
    .mockResolvedValueOnce([[ADMIN]])
    .mockResolvedValueOnce([[APPROVED_EVENT]]);
  db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
  db.mockConn.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
  db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
  db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
  db.mockConn.release = jest.fn();
  mockPrepareUpdate.mockReset().mockResolvedValue({ id: 91, operationKey: 'operation-91' });
  mockDeliverUpdate.mockReset().mockResolvedValue({
    update_id: 91,
    event_id: APPROVED_EVENT.id,
    communityhub_post_id: APPROVED_EVENT.communityhub_post_id,
    status: 'succeeded',
    response: { post: { id: 5101, approved: null } },
  });
  mockNormalizeImage.mockReset().mockResolvedValue(NORMALIZED_IMAGE);
});

it('preserves explicit nullable clears in both remote and local outbox edits', async () => {
  const response = await PATCH(request({ extended_description: null }), context);

  expect(response.status).toBe(200);
  expect(mockPrepareUpdate).toHaveBeenCalledWith(expect.objectContaining({
    chEdits: expect.objectContaining({ extendedDescription: '' }),
    localEdits: expect.objectContaining({ extended_description: null }),
  }));
});

it('clears both stored image representations when a poster is removed', async () => {
  const response = await PATCH(request({ image_cdn_url: null }), context);

  expect(response.status).toBe(200);
  expect(mockPrepareUpdate).toHaveBeenCalledWith(expect.objectContaining({
    chEdits: expect.objectContaining({ image_cdn_url: '' }),
    localEdits: expect.objectContaining({ image_cdn_url: null, image_data: null }),
  }));
});

it('rejects an invalid embedded poster before preparing the durable outbox', async () => {
  mockNormalizeImage.mockRejectedValueOnce(Object.assign(new Error('bad image'), {
    code: 'INVALID_IMAGE',
  }));

  const response = await PATCH(request({
    image_cdn_url: 'data:image/png;base64,bm90LWltYWdl',
  }), context);

  expect(response.status).toBe(422);
  expect(mockPrepareUpdate).not.toHaveBeenCalled();
});

it('returns a published edit to submitted until CommunityHub re-approval is verified', async () => {
  const response = await PATCH(request({ title: 'Updated Community Event' }), context);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ status: 'submitted', update_id: 91 });
  expect(mockPrepareUpdate).toHaveBeenCalledWith(expect.objectContaining({
    rawEventId: APPROVED_EVENT.id,
    originalStatus: 'approved',
    chEdits: expect.objectContaining({ title: 'Updated Community Event' }),
    localEdits: expect.objectContaining({ title: 'Updated Community Event' }),
  }));
});

it('fails closed after an ambiguous CommunityHub edit outcome', async () => {
  mockDeliverUpdate.mockResolvedValueOnce({
    update_id: 91,
    event_id: APPROVED_EVENT.id,
    communityhub_post_id: APPROVED_EVENT.communityhub_post_id,
    status: 'ambiguous',
    error: 'network timeout',
  });

  const response = await PATCH(request({ title: 'Updated Community Event' }), context);
  const body = await response.json();

  expect(response.status).toBe(502);
  expect(body).toMatchObject({ submission_state: 'unresolved', retry_safe: false });
  expect(mockPrepareUpdate).toHaveBeenCalledTimes(1);
});

it('uses a signed poster URL while the edited post awaits re-moderation', async () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = 'https://intake.example';

  try {
    const response = await PATCH(request({
      image_cdn_url: 'data:image/png;base64,iVBORw0KGgo=',
    }), context);

    expect(response.status).toBe(200);
    const draft = mockPrepareUpdate.mock.calls[0][0];
    expect(draft.chEdits.image_cdn_url).toContain('/api/events/10/poster.jpg?media_token=');
    expect(draft.localEdits).toMatchObject({
      image_cdn_url: null,
      image_data: NORMALIZED_IMAGE,
    });
    expect(draft.auditEntries[0].newValue).toContain('embedded image redacted');
  } finally {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  }
});
