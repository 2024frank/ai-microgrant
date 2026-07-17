import { NextRequest } from 'next/server';
import { eventImageResponse } from '@/lib/eventImageResponse';

// A slow third-party origin plus a sharp transcode can exceed the default
// serverless budget while a poster is being served.
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return eventImageResponse(req, id);
}
