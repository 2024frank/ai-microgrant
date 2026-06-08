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

  return Response.redirect(val, 302);
}
