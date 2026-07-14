import { NextRequest } from 'next/server';
import { GET as getNamedImage } from '@/app/api/events/[id]/[filename]/route';
import { GET as getImage } from '@/app/api/events/[id]/image/route';
import { createEventMediaToken } from '@/lib/eventMediaToken';
import { adminAuth } from '@/lib/firebase-admin';
import { loadImageAsJpeg, SafeImageError } from '@/lib/safeRemoteImage';

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
  status: 'pending',
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
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'approved' }]]);

    const response = await getNamedImage(namedRequest(), namedContext());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
  });

  it('permits CommunityHub to fetch only a signed publishing poster', async () => {
    const mediaToken = createEventMediaToken('10');
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'publishing' }]]);

    const response = await getNamedImage(
      namedRequest(`http://localhost/api/events/10/poster.jpg?media_token=${mediaToken}`),
      namedContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mockVerify).not.toHaveBeenCalled();
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
    db.default.query.mockResolvedValueOnce([[{ ...EVENT, status: 'approved' }]]);
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
