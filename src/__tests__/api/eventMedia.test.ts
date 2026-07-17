import { NextRequest } from 'next/server';
import { GET as getNamedImage } from '@/app/api/events/[id]/[filename]/route';
import { GET as getImage } from '@/app/api/events/[id]/image/route';
import { createEventMediaToken } from '@/lib/eventMediaToken';
import { adminAuth } from '@/lib/firebase-admin';
import { loadImageAsJpeg, SafeImageError } from '@/lib/safeRemoteImage';
import { createHmac } from 'node:crypto';

jest.mock('@/lib/safeRemoteImage', () => {
  class MockSafeImageError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
      this.name = 'SafeImageError';
    }
  }
  return { SafeImageError: MockSafeImageError, loadImageAsJpeg: jest.fn() };
});

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;
const mockLoadImage = loadImageAsJpeg as jest.Mock;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function namedRequest(url = 'http://localhost/api/events/10/poster.jpg') {
  return new NextRequest(url);
}

function namedContext(filename = 'poster.jpg') {
  return { params: Promise.resolve({ id: '10', filename }) };
}

function imageContext() {
  return { params: Promise.resolve({ id: '10' }) };
}

const EVENT = {
  image_data: 'data:image/jpeg;base64,/9j/2Q==',
  image_cdn_url: null,
  pending_image_data: null,
  status: 'pending',
  communityhub_moderation_status: 'pending',
  source_id: 3,
};

beforeEach(() => {
  process.env.MEDIA_PROXY_SECRET = 'test-media-proxy-secret-123';
  db.default.query.mockReset();
  mockVerify.mockReset();
  mockLoadImage.mockReset().mockResolvedValue(JPEG);
});

describe('event media routes', () => {
  it('hides a pending poster from anonymous callers', async () => {
    db.default.query.mockResolvedValueOnce([[EVENT]]);

    const response = await getNamedImage(namedRequest(), namedContext());

    expect(response.status).toBe(404);
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it('enforces source assignment for an authenticated pending image', async () => {
    const reviewer = {
      role: 'reviewer',
      active: 1,
      email: 'reviewer@oberlin.edu',
      firebase_uid: 'uid-reviewer',
    };
    mockVerify.mockResolvedValue({ uid: reviewer.firebase_uid, email: reviewer.email });
    db.default.query
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[reviewer]])
      .mockResolvedValueOnce([[{ allowed: 0 }]]);

    const response = await getImage(new NextRequest('http://localhost/api/events/10/image', {
      headers: { Authorization: 'Bearer valid' },
    }), imageContext());

    expect(response.status).toBe(403);
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it('serves assigned pending media privately', async () => {
    const reviewer = {
      role: 'reviewer',
      active: 1,
      email: 'reviewer@oberlin.edu',
      firebase_uid: 'uid-reviewer',
    };
    mockVerify.mockResolvedValue({ uid: reviewer.firebase_uid, email: reviewer.email });
    db.default.query
      .mockResolvedValueOnce([[EVENT]])
      .mockResolvedValueOnce([[reviewer]])
      .mockResolvedValueOnce([[{ allowed: 1 }]]);

    const response = await getImage(new NextRequest('http://localhost/api/events/10/image', {
      headers: { Authorization: 'Bearer valid' },
    }), imageContext());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('serves approved media publicly', async () => {
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'approved', communityhub_moderation_status: 'approved' }]]);

    const response = await getNamedImage(namedRequest(), namedContext());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
  });

  it('permits CommunityHub to fetch only a signed publishing poster', async () => {
    const mediaToken = createEventMediaToken('10', EVENT.image_data);
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'publishing' }]]);

    const response = await getNamedImage(
      namedRequest(`http://localhost/api/events/10/poster.jpg?media_token=${mediaToken}`),
      namedContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('serves the pending outbox poster before local PATCH finalization', async () => {
    const pendingImage = 'data:image/jpeg;base64,bmV3LWltYWdl';
    const mediaToken = createEventMediaToken('10', pendingImage);
    db.default.query.mockResolvedValueOnce([[
      { ...EVENT, status: 'submitted', pending_image_data: pendingImage },
    ]]);

    const response = await getNamedImage(
      namedRequest(`http://localhost/api/events/10/poster.jpg?media_token=${mediaToken}`),
      namedContext(),
    );

    expect(response.status).toBe(200);
    expect(mockLoadImage).toHaveBeenCalledWith(pendingImage);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('does not let an old signed URL expose a staged replacement poster', async () => {
    const replacement = 'data:image/jpeg;base64,bmV3LWltYWdl';
    const oldToken = createEventMediaToken('10', EVENT.image_data);
    db.default.query.mockResolvedValueOnce([[
      { ...EVENT, status: 'submitted', pending_image_data: replacement },
    ]]);

    const response = await getNamedImage(
      namedRequest(`http://localhost/api/events/10/poster.jpg?media_token=${oldToken}`),
      namedContext(),
    );

    expect(response.status).toBe(404);
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it('never accepts a legacy event-only token after an update is submitted', async () => {
    const legacyToken = createHmac('sha256', process.env.MEDIA_PROXY_SECRET!)
      .update('event-media:v1:10')
      .digest('base64url');
    db.default.query.mockResolvedValueOnce([[
      {
        ...EVENT,
        status: 'submitted',
        image_data: 'data:image/jpeg;base64,cmVwbGFjZW1lbnQ=',
        pending_image_data: null,
      },
    ]]);

    const response = await getNamedImage(
      namedRequest(`http://localhost/api/events/10/poster.jpg?media_token=${legacyToken}`),
      namedContext(),
    );

    expect(response.status).toBe(404);
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it('never gives a tokenized approved poster a public cache lifetime', async () => {
    const mediaToken = createEventMediaToken('10', EVENT.image_data);
    db.default.query.mockResolvedValueOnce([[
      { ...EVENT, status: 'approved', communityhub_moderation_status: 'approved' },
    ]]);

    const response = await getNamedImage(
      namedRequest(`http://localhost/api/events/10/poster.jpg?media_token=${mediaToken}`),
      namedContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('refuses a legacy self-referential poster URL instead of recursively fetching it', async () => {
    db.default.query.mockResolvedValueOnce([[
      {
        ...EVENT,
        image_data: null,
        image_cdn_url: 'https://intake.example/api/events/10/poster.jpg',
        status: 'approved',
        communityhub_moderation_status: 'approved',
      },
    ]]);

    const response = await getNamedImage(namedRequest(), namedContext());

    expect(response.status).toBe(404);
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it('hides a publishing poster when its media signature is invalid', async () => {
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'publishing' }]]);

    const response = await getNamedImage(
      namedRequest('http://localhost/api/events/10/poster.jpg?media_token=invalid'),
      namedContext(),
    );

    expect(response.status).toBe(404);
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  it('returns an error instead of arbitrary bytes when decoding fails', async () => {
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'approved', communityhub_moderation_status: 'approved' }]]);
    mockLoadImage.mockRejectedValueOnce(new SafeImageError('INVALID_IMAGE', 'bad image'));

    const response = await getNamedImage(namedRequest(), namedContext());

    expect(response.status).toBe(422);
    expect(await response.text()).toBe('Image unavailable');
    expect(response.headers.get('content-type')).not.toBe('image/jpeg');
  });

  it('does not expose the catch-all media route under a non-JPEG filename', async () => {
    const response = await getNamedImage(
      new NextRequest('http://localhost/api/events/10/secrets.txt'),
      namedContext('secrets.txt'),
    );
    expect(response.status).toBe(404);
    expect(db.default.query).not.toHaveBeenCalled();
  });
});
