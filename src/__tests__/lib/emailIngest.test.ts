const mockFetchUnreadEmails = jest.fn();
const mockExtractEventsFromEmail = jest.fn();
const mockMarkEmailsRead = jest.fn();
const mockPersistExtractedEvents = jest.fn();

jest.mock('@/lib/emailFetch', () => ({
  fetchUnreadEmails: mockFetchUnreadEmails,
  extractEventsFromEmail: mockExtractEventsFromEmail,
  markEmailsRead: mockMarkEmailsRead,
}));

jest.mock('@/lib/eventIngestion', () => ({
  persistExtractedEvents: mockPersistExtractedEvents,
}));

import { triggerEmailIngest } from '@/lib/agentRunner';

const db = require('@/lib/db');

const SOURCE = {
  id: 7,
  name: 'Community Inbox',
  active: 1,
  source_type: 'email',
};

const EMAILS = [
  { uid: 1, from: 'one@example.org', subject: 'One', body: 'First' },
  { uid: 2, from: 'two@example.org', subject: 'Two', body: 'Second' },
  { uid: 3, from: 'three@example.org', subject: 'Three', body: 'Third' },
];

const EVENT = {
  eventType: 'ot',
  title: 'Open House',
  description: 'Join the community open house.',
};

function terminalUpdate() {
  return db.default.query.mock.calls.find(
    (call: any[]) => typeof call[0] === 'string' && call[0].includes('SET status=?'),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EMAIL_MAX_PER_RUN;
  delete process.env.EMAIL_RUN_TIMEOUT_MS;

  mockFetchUnreadEmails.mockResolvedValue(EMAILS);
  mockMarkEmailsRead.mockResolvedValue(undefined);
  mockPersistExtractedEvents.mockResolvedValue({
    inserted: [{ id: 51, title: EVENT.title }],
    skipped: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0,
    errors: [],
  });

  db.default.query.mockImplementation((sql: unknown) =>
    typeof sql === 'string' && /FROM sources/i.test(sql)
      ? Promise.resolve([[SOURCE]])
      : typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
      ? Promise.resolve([[{ status: 'running' }]])
      : Promise.resolve([{ affectedRows: 1 }]),
  );
});

describe('triggerEmailIngest', () => {
  it('caps the batch and checkpoints each successful email before later failures', async () => {
    mockExtractEventsFromEmail
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce([{ ...EVENT }]);

    const result = await triggerEmailIngest(SOURCE.id, 90);

    expect(mockFetchUnreadEmails).toHaveBeenCalledWith(5);
    expect(mockMarkEmailsRead).toHaveBeenNthCalledWith(1, [1]);
    expect(mockMarkEmailsRead).toHaveBeenNthCalledWith(2, [3]);
    expect(mockMarkEmailsRead).not.toHaveBeenCalledWith([2]);
    expect(result).toMatchObject({ inserted: 1, skipped: 0 });

    const update = terminalUpdate();
    expect(update?.[1]?.slice(0, 5)).toEqual(['completed', 1, 1, 0, 1]);
    expect(update?.[0]).toContain("status='running'");
  });

  it('leaves a fatal email unread and fails a batch with no successful checkpoint', async () => {
    mockFetchUnreadEmails.mockResolvedValue([EMAILS[0]]);
    mockExtractEventsFromEmail.mockResolvedValue([{ ...EVENT }]);
    mockPersistExtractedEvents.mockResolvedValue({
      inserted: [],
      skipped: 1,
      duplicates: 0,
      invalid: 1,
      failed: 1,
      errors: [{
        index: 0,
        title: EVENT.title,
        inserted: false,
        issues: [{ path: 'description', code: 'required', message: 'is required' }],
      }],
    });

    await expect(triggerEmailIngest(SOURCE.id, 91))
      .rejects.toThrow('messages remain unread');

    expect(mockMarkEmailsRead).not.toHaveBeenCalled();
    const update = terminalUpdate();
    expect(update?.[1]?.slice(0, 5)).toEqual(['failed', 1, 0, 0, 1]);
    expect(update?.[1]?.[5]).toContain('could not be persisted');
  });

  it('marks duplicate-only emails read and counts only true duplicates', async () => {
    mockFetchUnreadEmails.mockResolvedValue([EMAILS[0]]);
    mockExtractEventsFromEmail.mockResolvedValue([{ ...EVENT }]);
    mockPersistExtractedEvents.mockResolvedValue({
      inserted: [],
      skipped: 1,
      duplicates: 1,
      invalid: 0,
      failed: 0,
      errors: [],
    });

    await expect(triggerEmailIngest(SOURCE.id, 92)).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
    });

    expect(mockMarkEmailsRead).toHaveBeenCalledWith([1]);
    const update = terminalUpdate();
    expect(update?.[1]?.slice(0, 5)).toEqual(['completed', 1, 0, 1, 0]);
  });

  it('does not process or terminally update a run that was stopped', async () => {
    mockFetchUnreadEmails.mockResolvedValue([EMAILS[0]]);
    db.default.query.mockImplementation((sql: unknown) =>
      typeof sql === 'string' && /FROM sources/i.test(sql)
        ? Promise.resolve([[SOURCE]])
        : typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)
        ? Promise.resolve([[{ status: 'stopped' }]])
        : Promise.resolve([{ affectedRows: 1 }]),
    );

    await expect(triggerEmailIngest(SOURCE.id, 93)).resolves.toMatchObject({
      inserted: 0,
      skipped: 0,
    });

    expect(mockExtractEventsFromEmail).not.toHaveBeenCalled();
    expect(mockMarkEmailsRead).not.toHaveBeenCalled();
    expect(terminalUpdate()).toBeUndefined();
  });

  it('leaves an email unread when the scheduler revokes the run after extraction', async () => {
    mockFetchUnreadEmails.mockResolvedValue([EMAILS[0]]);
    mockExtractEventsFromEmail.mockResolvedValue([{ ...EVENT }]);
    let statusReads = 0;
    db.default.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && /FROM sources/i.test(sql)) {
        return Promise.resolve([[SOURCE]]);
      }
      if (typeof sql === 'string' && /SELECT status FROM agent_runs/i.test(sql)) {
        statusReads++;
        return Promise.resolve([[
          { status: statusReads === 1 ? 'running' : 'failed' },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await expect(triggerEmailIngest(SOURCE.id, 95)).resolves.toMatchObject({
      inserted: 0,
      skipped: 0,
    });

    expect(mockExtractEventsFromEmail).toHaveBeenCalledTimes(1);
    expect(mockPersistExtractedEvents).not.toHaveBeenCalled();
    expect(mockMarkEmailsRead).not.toHaveBeenCalled();
    expect(terminalUpdate()).toBeUndefined();
  });

  it('does not hide checkpoint failures or mark the run completed', async () => {
    mockFetchUnreadEmails.mockResolvedValue([EMAILS[0]]);
    mockExtractEventsFromEmail.mockResolvedValue([]);
    mockMarkEmailsRead.mockRejectedValue(new Error('IMAP flag update failed'));

    await expect(triggerEmailIngest(SOURCE.id, 94))
      .rejects.toThrow('messages remain unread');

    const update = terminalUpdate();
    expect(update?.[1]?.[0]).toBe('failed');
    expect(update?.[1]?.[5]).toContain('IMAP flag update failed');
  });
});
