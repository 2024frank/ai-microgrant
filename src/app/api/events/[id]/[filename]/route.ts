import { NextRequest } from 'next/server';
import pool from '@/lib/db';

// Serves event images at any filename (e.g. poster.jpg) so CommunityHub
// accepts the URL — it validates that the URL has a recognised image extension.
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

  if (val.startsWith('data:')) {
    const comma = val.indexOf(',');
    if (comma === -1) return new Response('Invalid image data', { status: 500 });
    const mime = val.slice(5, val.indexOf(';'));
    const buf  = Buffer.from(val.slice(comma + 1), 'base64');
    return new Response(buf, {
      headers: {
        'Content-Type': mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // Proxy external images server-side so consumers (e.g. CommunityHub) always
  // receive real image bytes from our stable URL, instead of a redirect to a
  // third-party host whose downloader they may fail to fetch from.
  try {
    const upstream = await fetch(val, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) return new Response('Upstream image error', { status: 502 });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return new Response(buf, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new Response('Image fetch failed', { status: 502 });
  }
}
