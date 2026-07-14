import { NextRequest } from 'next/server';
import { eventImageResponse } from '@/lib/eventImageResponse';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return eventImageResponse(req, id);
}
