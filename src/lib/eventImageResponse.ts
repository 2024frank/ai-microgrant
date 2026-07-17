import type { NextRequest } from 'next/server';
import pool from './db';
import { getAuthUser } from './auth';
import { canAccessSource } from './reviewerAccess';
import { isValidEventMediaToken } from './eventMediaToken';
import { loadImageAsJpeg, SafeImageError } from './safeRemoteImage';

interface EventImageRow {
  image_data: string | null;
  image_cdn_url: string | null;
  pending_image_data: string | null;
  status: string;
  communityhub_moderation_status: string;
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
    `SELECT re.image_data, re.image_cdn_url, re.status,
            re.communityhub_moderation_status, re.source_id,
            (
              SELECT JSON_UNQUOTE(JSON_EXTRACT(cu.local_edits, '$.image_data'))
              FROM communityhub_updates cu
              WHERE cu.raw_event_id=re.id
                AND cu.status IN ('sending','ambiguous')
                AND JSON_TYPE(JSON_EXTRACT(cu.local_edits, '$.image_data'))='STRING'
              ORDER BY cu.id DESC LIMIT 1
            ) AS pending_image_data
     FROM raw_events re WHERE re.id = ?`,
    [id],
  ) as any as [[EventImageRow | undefined]];

  if (!event) return new Response('Not found', { status: 404 });

  const publishingToken = req.nextUrl.searchParams.get('media_token');
  const tokenizedRequest = Boolean(publishingToken);
  const value = event.pending_image_data || event.image_data || event.image_cdn_url;
  let publicAccess = event.status === 'approved'
    && event.communityhub_moderation_status === 'approved';
  if (!publicAccess) {
    // CommunityHub may fetch the poster after the submission response, while
    // its moderation state is still pending.
    const legacyPublishingToken = Boolean(publishingToken)
      && !publishingToken!.startsWith('v2.');
    // CommunityHub may re-download the poster well after submission (its own
    // moderation approval, edits, cache refresh). A v2 token proves the caller
    // was handed this exact media value by us, so content binding — not the
    // local workflow status — is the real capability; allow every state a
    // linked CommunityHub post can be in.
    const signedPublishingAccess = Boolean(value)
      && ['publishing', 'submitted', 'approved', 'resubmitted'].includes(event.status)
      // Legacy v1 tokens are event-only, so they are safe solely while the
      // initial request owns the immutable publishing lease. Submitted edits
      // must use a v2 token bound to the exact current poster.
      && (!legacyPublishingToken || event.status === 'publishing')
      && isValidEventMediaToken(id, publishingToken, value!);

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

  if (!value) return new Response('No image', { status: 404 });

  // Historical ingest rows pointed image_cdn_url back at this same handler.
  // Never recursively fetch the event's own proxy route after its blob expires.
  if (!event.pending_image_data && !event.image_data && isSelfPosterUrl(value, id)) {
    return new Response('No image', { status: 404 });
  }

  try {
    const jpeg = await loadImageAsJpeg(value);
    return new Response(new Uint8Array(jpeg), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': publicAccess && !tokenizedRequest
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

function isSelfPosterUrl(value: string, eventId: string): boolean {
  try {
    const url = new URL(value, 'https://local.invalid');
    const escapedId = eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/api/events/${escapedId}/(?:poster\\.jpg|image)/?$`).test(url.pathname);
  } catch {
    return false;
  }
}
