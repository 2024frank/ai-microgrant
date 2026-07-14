jest.mock('@/lib/mergePosters', () => ({
  mergePosterImages: jest.fn().mockResolvedValue(null),
}));

import { persistExtractedEvents } from '@/lib/eventIngestion';

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

  it('keeps fixable malformed output reviewable with field-level errors', async () => {
    const result = await persistExtractedEvents([{
      ...VALID_EVENT,
      postTypeId: [999],
      sessions: [{ startTime: 'tomorrow', endTime: 1_800_003_600 }],
    }], SOURCE, 12);

    expect(result.inserted).toHaveLength(1);
    expect(result.invalid).toBe(1);
    expect(result.errors[0]).toEqual(expect.objectContaining({ inserted: true }));
    expect(result.errors[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'postTypeId[0]' }),
      expect.objectContaining({ path: 'sessions[0].startTime' }),
    ]));

    const insert = db.mockConn.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO raw_events'),
    );
    expect(insert).toBeDefined();
    const storedIssues = JSON.parse(insert![1].at(-1));
    expect(storedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'postTypeId[0]' }),
    ]));
  });

  it('defaults omitted sponsors to the source organizer instead of failing validation', async () => {
    const { sponsors: _omitted, ...eventWithoutSponsors } = VALID_EVENT;
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
      if (sql.includes('FROM raw_events') && sql.includes('FOR UPDATE')) {
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
