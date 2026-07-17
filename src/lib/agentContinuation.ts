export async function enqueueAgentContinuation(origin: string, ids: number[]): Promise<void> {
  const secret = process.env.CRON_SECRET?.trim() || '';
  if (!secret) throw new Error('CRON_SECRET is not configured for agent continuation');

  const response = await fetch(new URL('/api/agent/runs', origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Agent continuation returned ${response.status}`);
  }
}
