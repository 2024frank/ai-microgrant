jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

jest.mock('@/lib/eventIngestion', () => ({
  persistExtractedEvents: jest.fn(),
}));

jest.mock('@/lib/email', () => ({
  sendReviewNotification: jest.fn().mockResolvedValue(undefined),
}));

import { after, NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/[slug]/route';
import { persistExtractedEvents } from '@/lib/eventIngestion';
import { sendReviewNotification } from '@/lib/email';

const db = require('@/lib/db');
const mockPersist = persistExtractedEvents as jest.Mock;
const mockAfter = after as jest.Mock;
const mockSendReviewNotification = sendReviewNotification as jest.Mock;

const SOURCE = { id: 4, slug: 'arts', name: 'Arts Calendar', active: 1 };

function request(events: unknown[], secret = 'ingest-secret') {
  return new NextRequest('http://localhost/api/ingest/arts', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ingest-secret': secret,
    },
    body: JSON.stringify({ events, count: events.length }),
  });
}

const context = { params: Promise.resolve({ slug: 'arts' }) };

describe('POST /api/ingest/:slug', () => {
  const callbacks: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    process.env.INGEST_SECRET = 'ingest-secret';
    db.default.query.mockReset();
    mockPersist.mockReset();
    mockSendReviewNotification.mockReset().mockResolvedValue(undefined);
    callbacks.length = 0;
    mockAfter.mockReset().mockImplementation((callback: () => Promise<void> | void) => {
      callbacks.push(callback);
    });
    mockPersist.mockResolvedValue({
      inserted: [],
      skipped: 0,
      invalid: 0,
      duplicates: 0,
      failed: 0,
      errors: [],
    });
  });

  it('fails closed when INGEST_SECRET is missing', async () => {
    delete process.env.INGEST_SECRET;

    const response = await POST(request([{ title: 'Anything' }], ''), context);

    expect(response.status).toBe(401);
    expect(db.default.query).not.toHaveBeenCalled();
  });

  it('reuses the scheduled source lease for direct agent posts', async () => {
    db.default.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM sources')) return Promise.resolve([[SOURCE]]);
      if (sql.includes("status='running'") && sql.includes('SELECT id')) {
        return Promise.resolve([[{ id: 77 }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request([{ title: 'Submitted event' }]), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.run_id).toBe(77);
    expect(mockPersist).toHaveBeenCalledWith(
      expect.any(Array),
      SOURCE,
      77,
      { expectedCorrectionEventId: undefined },
    );
    expect(db.default.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_runs'),
      expect.anything(),
    );
    const statsUpdate = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('events_extracted=events_extracted+?'),
    );
    expect(statsUpdate).toBeDefined();
    expect(statsUpdate[0]).not.toContain("status='completed'");
    expect(db.default.query.mock.calls.some(
      ([sql]: [string]) => sql.includes('id !='),
    )).toBe(false);
  });

  it('creates and completes a standalone run when no lease exists', async () => {
    db.default.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM sources')) return Promise.resolve([[SOURCE]]);
      if (sql.includes("status='running'") && sql.includes('SELECT id')) {
        return Promise.resolve([[]]);
      }
      if (sql.includes('INSERT INTO agent_runs')) {
        return Promise.resolve([{ insertId: 88 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request([{ title: 'Submitted event' }]), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.run_id).toBe(88);
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining("status='completed'"),
      expect.arrayContaining([88]),
    );
  });

  it('marks an owned run failed when persistence crashes', async () => {
    db.default.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM sources')) return Promise.resolve([[SOURCE]]);
      if (sql.includes("status='running'") && sql.includes('SELECT id')) {
        return Promise.resolve([[]]);
      }
      if (sql.includes('INSERT INTO agent_runs')) {
        return Promise.resolve([{ insertId: 91 }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    mockPersist.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(request([{ title: 'Submitted event' }]), context);

    expect(response.status).toBe(500);
    expect(db.default.query).toHaveBeenCalledWith(
      expect.stringContaining("status='failed'"),
      expect.arrayContaining([expect.stringContaining('database unavailable'), 91]),
    );
  });

  it('delivers source-scoped notifications through the Next after lifecycle', async () => {
    const inserted = [{ id: 501, title: 'Private Arts Preview' }];
    mockPersist.mockResolvedValueOnce({
      inserted,
      skipped: 0,
      invalid: 0,
      duplicates: 0,
      failed: 0,
      errors: [],
    });
    db.default.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM sources')) return Promise.resolve([[SOURCE]]);
      if (sql.includes("status='running'") && sql.includes('SELECT id')) {
        return Promise.resolve([[{ id: 77 }]]);
      }
      if (sql.includes('SELECT DISTINCT u.id')) {
        return Promise.resolve([[
          { id: 1, email: 'admin@example.org', full_name: 'Admin', role: 'admin' },
          { id: 2, email: 'arts@example.org', full_name: 'Arts Reviewer', role: 'reviewer' },
        ]]);
      }
      if (sql.includes('SUM(re.source_id = ?)')) {
        if (params?.length === 2) {
          return Promise.resolve([[
            { pending: 5, source_pending: 2, oldest_created_at: '2026-07-01T12:00:00Z' },
          ]]);
        }
        return Promise.resolve([[
          { pending: 20, source_pending: 2, oldest_created_at: '2026-06-01T12:00:00Z' },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const response = await POST(request([{ title: inserted[0].title }]), context);

    expect(response.status).toBe(200);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockSendReviewNotification).not.toHaveBeenCalled();

    await callbacks[0]();

    const recipientQuery = db.default.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('SELECT DISTINCT u.id'),
    );
    expect(recipientQuery[0]).toContain('target.source_id = ?');
    expect(recipientQuery[0]).toContain("u.role = 'admin'");
    expect(recipientQuery[0]).toContain("u.role = 'reviewer'");
    expect(recipientQuery[1]).toEqual([SOURCE.id]);

    const reviewerStatsQuery = db.default.query.mock.calls.find(
      ([sql, params]: [string, unknown[]]) =>
        sql.includes('SUM(re.source_id = ?)') && params.length === 2,
    );
    expect(reviewerStatsQuery[0]).toContain('reviewer_sources');
    expect(reviewerStatsQuery[1]).toEqual([SOURCE.id, 2]);

    expect(mockSendReviewNotification).toHaveBeenCalledWith(expect.objectContaining({
      reviewerEmail: 'admin@example.org',
      pendingCount: 20,
      previewEvents: [{ title: inserted[0].title, source: SOURCE.name }],
    }));
    expect(mockSendReviewNotification).toHaveBeenCalledWith(expect.objectContaining({
      reviewerEmail: 'arts@example.org',
      pendingCount: 5,
      sources: [{ name: SOURCE.name, count: 1, pending: 2 }],
      previewEvents: [{ title: inserted[0].title, source: SOURCE.name }],
    }));
  });
});
