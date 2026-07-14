import type { NextRequest } from 'next/server';
import pool from './db';
import { getAuthUser } from './auth';
import { canAccessSource } from './reviewerAccess';
import { isValidEventMediaToken } from './eventMediaToken';
import { loadImageAsJpeg, SafeImageError } from './safeRemoteImage';

interface EventImageRow {
  image_data: string | null;
  image_cdn_url: string | null;
  status: string;
  source_id: number;
}

function imageFailureStatus(error: unknown): number {
  if (!(error instanceof SafeImageError)) return 502;
  if (error.code === 'TOO_LARGE') return 413;
  if (error.code === 'UNSUPPORTED_TYPE') return 415;
  if (error.code === 'INVALID_IMAGE') return 422;
  return 502;
}

/** Shared, authorization-aware implementation for both event image routes. */
export async function eventImageResponse(req: NextRequest, id: string): Promise<Response> {
  const [[event]] = await pool.query(
    `SELECT image_data, image_cdn_url, status, source_id
     FROM raw_events WHERE id = ?`,
    [id],
  ) as any as [[EventImageRow | undefined]];

  if (!event) return new Response('Not found', { status: 404 });

  let publicAccess = event.status === 'approved';
  if (!publicAccess) {
    const publishingToken = req.nextUrl.searchParams.get('media_token');
    const signedPublishingAccess = event.status === 'publishing'
      && isValidEventMediaToken(id, publishingToken);

    if (!signedPublishingAccess) {
      if (!req.headers.get('authorization')) {
        // Do not disclose the existence or poster state of a pending record.
        return new Response('Not found', { status: 404 });
      }
      const user = await getAuthUser(req);
      if (!user) return new Response('Unauthorized', { status: 401 });
      if (!(await canAccessSource(user, Number(event.source_id)))) {
        return new Response('Forbidden', { status: 403 });
      }
    }
    publicAccess = false;
  }

  const value = event.image_data || event.image_cdn_url;
  if (!value) return new Response('No image', { status: 404 });

  try {
    const jpeg = await loadImageAsJpeg(value);
    return new Response(new Uint8Array(jpeg), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': publicAccess
          ? 'public, max-age=86400, s-maxage=86400'
          : 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Authorization',
      },
    });
  } catch (error) {
    const code = error instanceof SafeImageError ? error.code : 'UNEXPECTED';
    console.error(`[event image] unable to serve event ${id}: ${code}`);
    return new Response('Image unavailable', {
      status: imageFailureStatus(error),
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}
