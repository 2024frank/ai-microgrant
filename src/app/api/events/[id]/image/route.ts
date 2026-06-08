import { NextRequest } from 'next/server';
import pool from '@/lib/db';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const [[event]] = await pool.query(
    'SELECT image_data, image_cdn_url FROM raw_events WHERE id = ?', [id]
  ) as any;

  if (!event) return new Response('Not found', { status: 404 });

  // image_data holds the raw base64 data URI; image_cdn_url is a fallback URL
  const val: string = event.image_data || event.image_cdn_url;
  if (!val) return new Response('No image', { status: 404 });

  // Decode a data URI and serve the bytes directly
  if (val.startsWith('data:')) {
    const comma = val.indexOf(',');
    if (comma === -1) return new Response('Invalid image data', { status: 500 });
    const mime = val.slice(5, val.indexOf(';'));
    const b64  = val.slice(comma + 1);
    const buf  = Buffer.from(b64, 'base64');
    return new Response(buf, {
      headers: {
        'Content-Type': mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // It's a regular URL — redirect so CommunityHub follows it
  return Response.redirect(val, 302);
}
