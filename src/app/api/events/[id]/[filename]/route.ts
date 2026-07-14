import { NextRequest } from 'next/server';
import { eventImageResponse } from '@/lib/eventImageResponse';

// Serves event images at any filename (e.g. poster.jpg) so CommunityHub
// accepts the URL — it validates the URL extension AND sniffs actual image
// bytes. We always output JPEG regardless of source format.
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await context.params;
  if (!/\.jpe?g$/i.test(filename)) return new Response('Not found', { status: 404 });
  return eventImageResponse(req, id);
}
