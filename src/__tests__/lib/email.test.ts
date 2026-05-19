// Test email templates render correct content
// Mock Resend so no real emails are sent

const mockSend = jest.fn().mockResolvedValue({ id: 'mock-email-id' });

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

beforeEach(() => {
  mockSend.mockClear();
  process.env.RESEND_API_KEY      = 'test-key';
  process.env.NEXT_PUBLIC_APP_URL = 'https://test.oberlin.edu';
  jest.resetModules(); // fresh import each test so env vars are picked up
});

describe('Email templates', () => {
  it('sendReviewNotification sends to correct recipient with new count in subject', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'rev@oberlin.edu',
      reviewerName:  'Jane Reviewer',
      pendingCount:  7,
      sources:       [{ name: 'Apollo Theatre', count: 4 }, { name: 'City of Oberlin', count: 3 }],
      oldestDate:    'May 1',
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to:      'rev@oberlin.edu',
      subject: expect.stringContaining('7'),
    }));
  });

  it('review email subject has no emoji and names the source for single source', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 4, sources: [{ name: 'Apollo Theatre', count: 4 }], oldestDate: null,
    });
    const call = mockSend.mock.calls[0][0];
    expect(call.subject).toContain('Apollo Theatre');
    expect(call.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji
  });

  it('review email subject uses singular for 1 event', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 1, sources: [{ name: 'Apollo', count: 1 }], oldestDate: null,
    });
    const call = mockSend.mock.calls[0][0];
    expect(call.subject).toMatch(/1 new event\b/);
    expect(call.subject).not.toMatch(/1 new events/);
  });

  it('review email HTML contains key content', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 12, sources: [{ name: 'Apollo', count: 3, pending: 12 }], oldestDate: null,
    });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('Jane');
    expect(html).toContain('Apollo');
    expect(html).toContain('/reviewer/queue');
  });

  it('review email shows already-waiting backlog separate from new count', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 15,
      sources: [{ name: 'Apollo Theatre', count: 3, pending: 15 }],
      oldestDate: null,
    });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('3 new');
    expect(html).toContain('12 already waiting');
    expect(html).not.toContain('15 pending total');
  });

  it('review email omits already-waiting when there is no backlog', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 3,
      sources: [{ name: 'Apollo Theatre', count: 3, pending: 3 }],
      oldestDate: null,
    });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('3 new');
    expect(html).not.toContain('already waiting');
  });

  it('review email shows event preview titles when provided', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 3, sources: [{ name: 'Apollo', count: 3 }], oldestDate: null,
      previewEvents: [
        { title: 'Jazz Night', source: 'Apollo' },
        { title: 'Open Mic', source: 'Apollo' },
        { title: 'Classical Evening', source: 'Apollo' },
      ],
    });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('Jazz Night');
    expect(html).toContain('Open Mic');
    expect(html).toContain('Classical Evening');
  });

  it('review email caps preview at 5 events and shows overflow count', async () => {
    const { sendReviewNotification } = require('@/lib/email');
    const previewEvents = Array.from({ length: 8 }, (_, i) => ({ title: `Event ${i + 1}`, source: 'Src' }));
    await sendReviewNotification({
      reviewerEmail: 'r@o.edu', reviewerName: 'Jane',
      pendingCount: 8, sources: [{ name: 'Src', count: 8 }], oldestDate: null,
      previewEvents,
    });
    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('Event 1');
    expect(html).toContain('Event 5');
    expect(html).not.toContain('Event 6');
    expect(html).toContain('+ 3 more');
  });

  it('sendWelcomeEmail sends to new user with correct role', async () => {
    const { sendWelcomeEmail } = require('@/lib/email');
    await sendWelcomeEmail({ email: 'new@oberlin.edu', name: 'New User', role: 'reviewer' });

    const call = mockSend.mock.calls[0][0];
    expect(call.to).toBe('new@oberlin.edu');
    expect(call.subject).toContain('reviewer');
    expect(call.html).toContain('New User');
    expect(call.html).toContain('/reviewer/queue');
  });

  it('sendAgentRunSummary includes source results and error details', async () => {
    const { sendAgentRunSummary } = require('@/lib/email');
    await sendAgentRunSummary({
      adminEmail: 'admin@oberlin.edu',
      results: [
        { source: 'Oberlin College', status: 'ok',    inserted: 8 },
        { source: 'Apollo Theatre',  status: 'error', inserted: 0, error: 'Timeout' },
      ],
      totalNew: 8,
    });

    const html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('Oberlin College');
    expect(html).toContain('Apollo Theatre');
    expect(html).toContain('8');
    expect(html).toContain('Timeout');
  });
});
