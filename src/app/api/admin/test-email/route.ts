import { NextRequest } from 'next/server';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';
import { sendReviewNotification } from '@/lib/email';

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { to } = await req.json();
  if (!to) return Response.json({ error: 'to is required' }, { status: 400 });

  try {
    const result = await sendReviewNotification({
      reviewerEmail: to,
      reviewerName:  'Test User',
      pendingCount:  5,
      sources:       [{ name: 'Oberlin Localist', count: 3 }, { name: 'Test Source', count: 2 }],
      oldestDate:    '2 days ago',
    });
    return Response.json({ ok: true, resend: result });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
