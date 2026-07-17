import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const result = await authenticateRequest(req);
    if (!result.ok) {
      const status = result.reason === 'not_authorized' ? 403 : 401;
      return Response.json({
        error: status === 403 ? 'Not authorized' : 'Invalid token',
      }, { status });
    }

    return Response.json({
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
    });
  } catch (error) {
    const requestId = randomUUID();
    console.error(`[auth/me] request ${requestId} failed:`, error);
    return Response.json({
      error: 'Authentication service unavailable',
      request_id: requestId,
    }, { status: 503 });
  }
}
