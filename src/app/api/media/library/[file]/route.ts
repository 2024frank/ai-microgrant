import { NextRequest } from 'next/server';
import { LIBRARY_POSTERS } from '@/lib/libraryPosters';

export const maxDuration = 30;

/**
 * GET /api/media/library/<slug>.jpg (public, read-only)
 *
 * Serves an Oberlin Public Library program poster as a JPEG at a URL that
 * ends in a real image extension, because CommunityHub downloads a post's
 * image from its URL and rejects the extension-less Locable CDN URLs. The
 * slug must be one of the fixed LIBRARY_POSTERS keys, so this can only ever
 * fetch the known library images (no open proxy), and the bytes still pass
 * through the safe image pipeline.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ file: string }> },
) {
  const { file } = await context.params;
  const slug = file.replace(/\.(jpe?g|png)$/i, '');
  const poster = LIBRARY_POSTERS[slug];
  if (!poster) {
    return Response.json({ error: 'Unknown poster' }, { status: 404 });
  }
  try {
    const { loadImageAsJpeg } = await import('@/lib/safeRemoteImage');
    const jpeg = await loadImageAsJpeg(poster.image);
    return new Response(new Uint8Array(jpeg), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch (error) {
    return Response.json({
      error: 'Poster is temporarily unavailable',
      detail: error instanceof Error ? error.message : 'image load failed',
    }, { status: 502 });
  }
}
