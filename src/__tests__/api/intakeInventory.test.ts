import { NextRequest } from 'next/server';
import { GET } from '@/app/api/inventory/intake/route';
import { intakeInventoryToken, withIntakeInventoryToken } from '@/lib/intakeInventoryAccess';
import { INTAKE_INVENTORY_URL } from '@/lib/communityHubInventory';

const db = require('@/lib/db');

function makeReq(token?: string | null) {
  const query = token ? `?token=${token}` : '';
  return new NextRequest(`http://localhost/api/inventory/intake${query}`);
}

describe('GET /api/inventory/intake', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    db.default.query.mockReset();
  });

  it('returns active drafts as comparison content without record IDs', async () => {
    db.default.query.mockResolvedValue([[{
      id: 123,
      title: 'Community Jazz Night',
      event_type: 'ot',
      description: 'An evening of live community jazz in downtown Oberlin.',
      extended_description: null,
      calendar_source_url: 'https://example.org/events/jazz',
      sessions: JSON.stringify([{ startTime: 1_800_000_000, endTime: 1_800_003_600 }]),
      status: 'pending',
      source_name: 'Oberlin Community Arts',
    }]]);

    const response = await GET(makeReq(intakeInventoryToken()));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.events[0]).toEqual({
      title: 'Community Jazz Night',
      event_type: 'ot',
      description: 'An evening of live community jazz in downtown Oberlin.',
      extended_description: '',
      calendar_source_url: 'https://example.org/events/jazz',
      sessions: [{ start: 1_800_000_000, end: 1_800_003_600 }],
      status: 'pending',
      source: 'Oberlin Community Arts',
    });
    // Agents compare content, never IDs; the response must not carry any.
    expect(body.events[0]).not.toHaveProperty('id');

    const [sql] = db.default.query.mock.calls[0];
    expect(sql).toContain("re.status IN ('pending','submitted','approved','publishing','resubmitted','pending_fix')");
  });

  it('rejects requests without a valid read token (drafts are unreviewed)', async () => {
    const missing = await GET(makeReq());
    expect(missing.status).toBe(401);
    const wrong = await GET(makeReq('0000000000000000000000000000dead'));
    expect(wrong.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('refuses to serve anything when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(makeReq('anything'));
    expect(response.status).toBe(503);
  });

  it('degrades to 503 when the database is unavailable', async () => {
    db.default.query.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const response = await GET(makeReq(intakeInventoryToken()));
    expect(response.status).toBe(503);
  });

  it('embeds the tokened inventory URL into prompt text exactly once', async () => {
    const prompt = `fetch: GET ${INTAKE_INVENTORY_URL}\ndone`;
    const tokened = withIntakeInventoryToken(prompt);
    expect(tokened).toContain(`${INTAKE_INVENTORY_URL}?token=${intakeInventoryToken()}`);
    // Applying it twice must not stack tokens.
    expect(withIntakeInventoryToken(tokened)).toBe(tokened);
  });
});
