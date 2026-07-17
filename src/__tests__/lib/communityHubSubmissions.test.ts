import {
  recoverSucceededCommunityHubSubmissions,
  releaseStalePreparedCommunityHubSubmissions,
} from '@/lib/communityHubSubmissions';

const db = require('@/lib/db');

describe('succeeded CommunityHub submission recovery', () => {
  beforeEach(() => {
    db.default.query.mockReset().mockResolvedValue([[{ id: 10 }]]);
    db.default.getConnection.mockReset().mockResolvedValue(db.mockConn);
    db.mockConn.query.mockReset().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, status FROM raw_events')) {
        return Promise.resolve([[{ id: 10, status: 'publishing' }]]);
      }
      if (sql.includes("status='prepared'") && sql.includes('SELECT id')) {
        return Promise.resolve([[{ id: 77 }]]);
      }
      if (sql.includes("status='succeeded'") && sql.includes('communityhub_submissions')) {
        return Promise.resolve([[
          {
            id: 88,
            communityhub_post_id: '5101',
            response: JSON.stringify({ post: { id: 5101, approved: null } }),
            reviewer_id: 7,
          },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    db.mockConn.beginTransaction = jest.fn().mockResolvedValue(undefined);
    db.mockConn.commit = jest.fn().mockResolvedValue(undefined);
    db.mockConn.rollback = jest.fn().mockResolvedValue(undefined);
    db.mockConn.release = jest.fn();
  });

  it('links the stored post id locally without making another network request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const recovered = await recoverSucceededCommunityHubSubmissions(20);

    expect(recovered).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('pending','publishing')"),
      ['5101', 10, '5101'],
    );
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO review_sessions'),
      [10, 7, null, JSON.stringify({ post: { id: 5101, approved: null } }), 10],
    );
    expect(db.mockConn.commit).toHaveBeenCalled();
  });

  it('safely releases a stale intent that never crossed the network boundary', async () => {
    const released = await releaseStalePreparedCommunityHubSubmissions(20);

    expect(released).toBe(1);
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining("error_message='Recovered abandoned pre-dispatch submission intent'"),
      [10],
    );
    expect(db.mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='pending', publish_started_at=NULL"),
      [10],
    );
    expect(db.mockConn.commit).toHaveBeenCalled();
  });
});
