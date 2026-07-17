jest.mock('@/lib/mergePosters', () => ({
  mergePosterImages: jest.fn().mockResolvedValue(null),
  MAX_POSTER_IMAGES: 4,
}));

jest.mock('@/lib/safeRemoteImage', () => ({
  normalizeEmbeddedImageData: jest.fn(),
}));

import { persistExtractedEvents } from '@/lib/eventIngestion';
import { mergePosterImages } from '@/lib/mergePosters';
import { normalizeEmbeddedImageData } from '@/lib/safeRemoteImage';

const db = require('@/lib/db');

const SOURCE = {
  id: 7,
  name: 'Oberlin Community Arts',
  calendar_source_name: 'Oberlin Community Arts',
};

const VALID_EVENT = {
  eventType: 'ot',
  title: 'Community Jazz Night',
  description: 'An evening of live community jazz in downtown Oberlin.',
  sponsors: ['Oberlin Community Arts'],
  postTypeId: [8],
  sessions: [{ startTime: 1_800_000_000, endTime: 1_800_003_600 }],
  locationType: 'ne',
  image_cdn_url: 'https://images.example.org/poster.jpg',
  website: 'https://www.example.org/events/jazz-night',
  display: 'all',
};

describe('persistExtractedEvents', () => {
  beforeEach(() => {
    process.env.COMMUNITYHUB_EMAIL = 'calendar@oberlin.edu';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    db.default.getConnection.mockResolvedValue(db.mockConn);
    db.mockConn.query.mockReset();
    let nextId = 40;
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_runs')) return Promise.resolve([[{ id: 12 }]]);
      if (sql.includes('FROM needs_fix')) return Promise.resolve([[]]);
      if (sql.includes('SELECT id FROM raw_events')) return Promise.resolve([[]]);
      if (sql.includes("status = 'pending_fix'")) return Promise.resolve([[]]);
      if (sql.includes('INSERT INTO raw_events')) {
        return Promise.resolve([{ insertId: nextId++ }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release = jest.fn();
    (mergePosterImages as jest.Mock).mockReset().mockResolvedValue(null);
    (normalizeEmbeddedImageData as jest.Mock).mockReset().mockImplementation(
      async () => 'data:image/jpeg;base64,bm9ybWFsaXplZA==',
    );
  });

  it('stores a contract-valid event with canonical fields', async () => {
    const result = await persistExtractedEvents([VALID_EVENT], SOURCE, 12);

    expect(result).toEqual(expect.objectContaining({ inserted: [expect.objectContaining({ id: 40 })] }));
    expect(result.skipped).toBe(0);
    expect(result.invalid).toBe(0);

    const insert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    );
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      'ot',
      'calendar@oberlin.edu',
      JSON.stringify([8]),
    ]));
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
    expect(db.mockConn.release).toHaveBeenCalledTimes(1);
  });

  it('auto-rejects drafts missing required fields and preserves the reason (meeting item 12)', async () => {
    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      postTypeId: [999],
      sessions: [{ startTime: 'tomorrow', endTime: 1_800_003_600 }],
    }], SOURCE, 12);

    // Required categories/sessions cannot be satisfied, so the draft is
    // rejected as "Required fields are missing" instead of blocking review.
    expect(result.inserted).toHaveLength(0);
    expect(result.auto_rejected).toBe(1);
    expect(result.invalid).toBe(1);
    expect(result.errors[0]).toEqual(expect.objectContaining({ inserted: true }));
    expect(result.errors[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'postTypeId[0]' }),
      expect.objectContaining({ path: 'sessions[0].startTime' }),
    ]));

    const rejectionInsert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO rejection_log'),
    );
    expect(rejectionInsert).toBeDefined();
    expect(rejectionInsert![0]).toContain("'system'");
    expect(rejectionInsert![1]).toEqual(expect.arrayContaining([
      JSON.stringify(['missing_fields']),
      expect.stringContaining('Required fields are missing.'),
    ]));

    const insert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    );
    expect(insert).toBeDefined();
    // Parameter layout: [..., validation_errors, duplicate_of_id,
    // communityhub_match, status]. The candidate is preserved with its
    // field-level evidence and a 'rejected' status.
    expect(insert![1].at(-1)).toBe('rejected');
    const storedIssues = JSON.parse(insert![1].at(-4));
    expect(storedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'postTypeId[0]' }),
    ]));
  });

  it('defaults omitted sponsors to the source organizer instead of failing validation', async () => {
    const eventWithoutSponsors = Object.fromEntries(
      Object.entries(VALID_EVENT).filter(([key]) => key !== 'sponsors'),
    );
    const result = await persistExtractedEvents([eventWithoutSponsors], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.invalid).toBe(0);

    const insert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    );
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      JSON.stringify(['Oberlin Community Arts']),
    ]));
  });

  it('normalizes embedded posters without persisting the local serving URL as CDN data', async () => {
    const original = 'data:image/png;base64,aW1hZ2U=';
    const normalized = 'data:image/jpeg;base64,bm9ybWFsaXplZA==';
    (normalizeEmbeddedImageData as jest.Mock).mockResolvedValueOnce(normalized);

    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      image_cdn_url: original,
    }], SOURCE, 12);

    expect(result).toMatchObject({ skipped: 0, invalid: 0 });
    expect(normalizeEmbeddedImageData).toHaveBeenCalledWith(original);
    const insert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    );
    // image_cdn_url stays null; the verified bytes live only in image_data.
    expect(insert?.[1][22]).toBeNull();
    expect(insert?.[1][23]).toBe(normalized);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringMatching(/SET ingested_post_url = \?\s+WHERE id = \?/),
      ['http://localhost:3000/reviewer/events/40', 40],
    );
    expect(db.mockConn.query.mock.calls.some(
      ([sql, params]: [string, unknown[]]) => (
        sql.includes('UPDATE raw_events')
        && params?.some(value => typeof value === 'string' && value.includes('/poster.jpg'))
      ),
    )).toBe(false);
  });

  it('keeps an event but drops and reports an invalid embedded poster', async () => {
    (normalizeEmbeddedImageData as jest.Mock).mockRejectedValueOnce(new Error('bad bytes'));

    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      image_cdn_url: 'data:image/png;base64,bm90LWEtcmVhbC1pbWFnZQ==',
    }], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.invalid).toBe(1);
    expect(result.errors[0]).toMatchObject({ inserted: true });
    expect(result.errors[0].issues).toContainEqual(expect.objectContaining({
      path: 'image_cdn_url',
      code: 'invalid_embedded_image',
    }));
    const insert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    );
    expect(insert?.[1][22]).toBeNull();
    expect(insert?.[1][23]).toBeNull();
  });

  it('reports unsafe, excess, and all-failed multi-poster input while keeping the event', async () => {
    const safeUrls = Array.from(
      { length: 5 },
      (_, index) => `https://images.example.com/poster-${index}.jpg`,
    );

    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      poster_urls: [
        'http://127.0.0.1/private.jpg',
        'not-a-url',
        ...safeUrls,
      ],
    }], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.invalid).toBe(1);
    expect(mergePosterImages).toHaveBeenCalledWith(safeUrls.slice(0, 2));
    expect(result.errors[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsafe_poster_url' }),
      expect.objectContaining({ code: 'too_many_posters' }),
      expect.objectContaining({ code: 'poster_images_unusable' }),
    ]));
  });

  it('isolates malformed items instead of rolling back the batch', async () => {
    const result = await persistExtractedEvents([null, VALID_EVENT], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.invalid).toBe(1);
    expect(db.mockConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
  });

  it('rejects fully expired agent output before it reaches the review queue', async () => {
    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      sessions: [{ startTime: 1_700_000_000, endTime: 1_700_003_600 }],
    }], SOURCE, 12);

    expect(result).toMatchObject({ inserted: [], skipped: 1, invalid: 1, failed: 1 });
    expect(result.errors[0].issues).toContainEqual(expect.objectContaining({
      path: 'sessions',
      code: 'expired',
    }));
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('requires correction requests to belong to the same source', async () => {
    const result = await persistExtractedEvents([
      { ...VALID_EVENT, fixedFromEventId: 99 },
    ], SOURCE, 12);

    expect(result.inserted).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.errors[0].issues).toContainEqual(expect.objectContaining({
      path: 'fixedFromEventId',
      code: 'not_found',
    }));
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM needs_fix'),
      [99, SOURCE.id],
    );
  });

  it('binds correction runs to exactly one matching event id', async () => {
    const missingId = await persistExtractedEvents(
      [VALID_EVENT],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );
    expect(missingId.inserted).toHaveLength(0);
    expect(missingId.failed).toBe(1);
    expect(missingId.errors[0].issues).toContainEqual(expect.objectContaining({
      path: 'fixedFromEventId',
      code: 'correction_mismatch',
    }));

    const extraEvents = await persistExtractedEvents(
      [
        { ...VALID_EVENT, fixedFromEventId: 99 },
        { ...VALID_EVENT, fixedFromEventId: 99, title: 'Unexpected second event' },
      ],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );
    expect(extraEvents.inserted).toHaveLength(0);
    expect(extraEvents.failed).toBe(2);
    expect(extraEvents.errors[0].issues).toContainEqual(expect.objectContaining({
      code: 'correction_count',
    }));

    const partialId = await persistExtractedEvents(
      [{ ...VALID_EVENT, fixedFromEventId: '99-ignore-this' }],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );
    expect(partialId.inserted).toHaveLength(0);
    expect(partialId.errors[0].issues).toContainEqual(expect.objectContaining({
      code: 'correction_mismatch',
    }));
  });

  it('atomically supersedes a correction target and persists reviewer feedback', async () => {
    const original = {
      id: 99,
      source_id: SOURCE.id,
      status: 'pending_fix',
      title: 'Old Jazz Night',
      description: 'The old event description.',
      event_type: 'ot',
      sponsors: JSON.stringify(['Old Sponsor']),
      post_type_ids: JSON.stringify([8]),
      sessions: JSON.stringify(VALID_EVENT.sessions),
      location_type: 'ne',
    };
    const fixRequest = {
      raw_event_id: 99,
      source_id: SOURCE.id,
      correction_notes: 'Use the source title and sponsor.',
      sent_by_user_id: 4,
      sent_by_email: 'reviewer@oberlin.edu',
    };
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_runs')) return Promise.resolve([[{ id: 12 }]]);
      if (sql.includes('FROM needs_fix')) return Promise.resolve([[fixRequest]]);
      if (sql.includes("status = 'pending_fix'") && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[original]]);
      }
      if (sql.includes('INSERT INTO raw_events')) return Promise.resolve([{ insertId: 101 }]);
      if (sql.includes('SELECT id FROM raw_events')) return Promise.resolve([[]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents(
      [{ ...VALID_EVENT, fixedFromEventId: 99, fixSummary: 'Corrected title and sponsor.' }],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );

    expect(result.inserted).toHaveLength(1);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'superseded'"),
      [101, 99],
    );
    expect(db.mockConn.query.mock.calls.some(
      ([sql]: [string]) => sql.includes('INSERT INTO field_edit_log'),
    )).toBe(true);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO rejection_log'),
      expect.arrayContaining(['Use the source title and sponsor.']),
    );
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'DELETE FROM needs_fix WHERE raw_event_id = ?',
      [99],
    );
  });

  it('keeps a rejected original archived while correction runs, then supersedes it', async () => {
    const original = {
      id: 99,
      source_id: SOURCE.id,
      status: 'rejected',
      sent_for_correction: 1,
      title: 'Rejected Jazz Night',
      description: 'Incorrect source details.',
      event_type: 'ot',
      sponsors: JSON.stringify(['Old Sponsor']),
      post_type_ids: JSON.stringify([8]),
      sessions: JSON.stringify(VALID_EVENT.sessions),
      location_type: 'ne',
    };
    const fixRequest = {
      raw_event_id: 99,
      source_id: SOURCE.id,
      correction_notes: 'Re-open the source and correct the event.',
      sent_by_user_id: 4,
      sent_by_email: 'reviewer@oberlin.edu',
    };
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_runs')) return Promise.resolve([[{ id: 13 }]]);
      if (sql.includes('FROM needs_fix')) return Promise.resolve([[fixRequest]]);
      if (sql.includes('SELECT * FROM raw_events') && sql.includes('FOR UPDATE')) {
        return Promise.resolve([[original]]);
      }
      if (sql.includes('INSERT INTO raw_events')) return Promise.resolve([{ insertId: 102 }]);
      if (sql.includes('SELECT id FROM raw_events')) return Promise.resolve([[]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents(
      [{ ...VALID_EVENT, fixedFromEventId: 99, fixSummary: 'Corrected from current source evidence.' }],
      SOURCE,
      13,
      { expectedCorrectionEventId: 99 },
    );

    expect(result.inserted).toHaveLength(1);
    const lockQuery = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('FROM raw_events') && sql.includes('FOR UPDATE'),
    )?.[0] as string;
    expect(lockQuery).toContain("status = 'rejected'");
    expect(lockQuery).toContain('sent_for_correction = 1');
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'superseded'"),
      [102, 99],
    );
    expect(db.mockConn.query).toHaveBeenCalledWith(
      'DELETE FROM needs_fix WHERE raw_event_id = ?',
      [99],
    );
  });

  it('fences a correction when its run lease was revoked before persistence', async () => {
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_runs')) return Promise.resolve([[]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents(
      [{ ...VALID_EVENT, fixedFromEventId: 99 }],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );

    expect(result).toMatchObject({ inserted: [], skipped: 1, failed: 1 });
    expect(result.errors[0].issues).toContainEqual(expect.objectContaining({
      code: 'database_error',
      message: 'correction run lease is no longer active',
    }));
    expect(db.mockConn.query.mock.calls.some(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    )).toBe(false);
  });

  it('does not supersede a rejected record with a correction that still violates the payload contract', async () => {
    const result = await persistExtractedEvents(
      [{ ...VALID_EVENT, fixedFromEventId: 99, postTypeId: [999] }],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );

    expect(result).toMatchObject({ inserted: [], skipped: 1, invalid: 1, failed: 1 });
    expect(result.errors[0].issues).toContainEqual(expect.objectContaining({
      path: 'postTypeId[0]',
    }));
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('does not supersede correction evidence when the agent returns an unsafe poster', async () => {
    (normalizeEmbeddedImageData as jest.Mock).mockRejectedValueOnce(new Error('unsafe poster'));

    const result = await persistExtractedEvents(
      [{
        ...VALID_EVENT,
        fixedFromEventId: 99,
        image_cdn_url: 'data:image/png;base64,bm90LWltYWdl',
      }],
      SOURCE,
      12,
      { expectedCorrectionEventId: 99 },
    );

    expect(result).toMatchObject({ inserted: [], skipped: 1, invalid: 1, failed: 1 });
    expect(result.errors[0].issues).toContainEqual(expect.objectContaining({
      code: 'invalid_embedded_image',
    }));
    expect(db.mockConn.beginTransaction).not.toHaveBeenCalled();
  });

  it('continues after one event fails to write', async () => {
    let insertCount = 0;
    let nextId = 70;
    db.mockConn.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM raw_events')) return Promise.resolve([[]]);
      if (sql.includes("status = 'pending_fix'")) return Promise.resolve([[]]);
      if (sql.includes('INSERT INTO raw_events')) {
        insertCount++;
        if (insertCount === 1) return Promise.reject(new Error('temporary database error'));
        return Promise.resolve([{ insertId: nextId++ }]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    const result = await persistExtractedEvents([
      { ...VALID_EVENT, title: 'First Event' },
      { ...VALID_EVENT, title: 'Second Event' },
    ], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.inserted[0].title).toBe('Second Event');
    expect(result.skipped).toBe(1);
    expect(result.invalid).toBe(1);
    expect(db.mockConn.rollback).toHaveBeenCalledTimes(1);
    expect(db.mockConn.commit).toHaveBeenCalledTimes(1);
  });
});
