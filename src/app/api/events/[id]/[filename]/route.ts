import { NextRequest } from 'next/server';
import pool from '@/lib/db';
import sharp from 'sharp';

// Serves event images at any filename (e.g. poster.jpg) so CommunityHub
// accepts the URL — it validates the URL extension AND sniffs actual image
// bytes. We always output JPEG regardless of source format.
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string; filename: string }> }
) {
  const { id } = await context.params;
  const [[event]] = await pool.query(
    'SELECT image_data, image_cdn_url FROM raw_events WHERE id = ?', [id]
  ) as any;

  if (!event) return new Response('Not found', { status: 404 });

  const val: string = event.image_data || event.image_cdn_url;
  if (!val) return new Response('No image', { status: 404 });

  let rawBuf: Buffer;

  if (val.startsWith('data:')) {
    const comma = val.indexOf(',');
    if (comma === -1) return new Response('Invalid image data', { status: 500 });
    rawBuf = Buffer.from(val.slice(comma + 1), 'base64');
  } else {
    // Proxy external URL — avoid sending Accept: image/webp so TMDB returns JPEG
    try {
      const upstream = await fetch(val, {
        headers: {
          'Accept': 'image/jpeg,image/png,image/gif,*/*;q=0.5',
          'User-Agent': 'CommunityHub-ImageProxy/1.0',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) return new Response('Upstream image error', { status: 502 });
      rawBuf = Buffer.from(await upstream.arrayBuffer());
    } catch {
      return new Response('Image fetch failed', { status: 502 });
    }
  }

  // Always re-encode as JPEG — CommunityHub rejects WebP even behind a .jpg URL
  try {
    const jpegBuf = await sharp(rawBuf).jpeg({ quality: 92 }).toBuffer();
    return new Response(jpegBuf, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    // If sharp can't decode it, serve raw and hope for the best
    return new Response(rawBuf, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }
}
