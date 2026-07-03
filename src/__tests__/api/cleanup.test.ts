import { NextRequest } from 'next/server';
import { POST } from '@/app/api/cleanup/route';

const db = require('@/lib/db');

function makeReq(secret = process.env.CRON_SECRET) {
  return new NextRequest('http://localhost/api/cleanup', {
    method: 'POST',
    headers: { 'x-cron-secret': secret ?? '' },
  });
}

function normalize(sql: string) {
  return sql.replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  db.default.query.mockReset();
  db.default.query.mockResolvedValue([{ affectedRows: 0 }]);
});

describe('POST /api/cleanup', () => {
  it('only archives and deletes expired events after review is complete', async () => {
    const res = await POST(makeReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    const archiveCall = db.default.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO event_stats_archive')
    );
    expect(archiveCall).toBeDefined();
    expect(normalize(archiveCall![0])).toContain("WHERE re.status IN ('approved','rejected')");

    const deleteCalls = db.default.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM raw_events')
    );
    expect(deleteCalls).toHaveLength(2);
    for (const call of deleteCalls) {
      expect(normalize(call[0])).toContain("status IN ('approved','rejected')");
    }
  });

  it('rejects requests without the cron secret', async () => {
    const res = await POST(makeReq('wrong-secret'));

    expect(res.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });
});
