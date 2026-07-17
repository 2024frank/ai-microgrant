import {
  COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS,
  compareEventContent,
  fetchCommunityHubInventory,
  findBestContentMatch,
  normalizeContentSessions,
  type CommunityHubInventoryPost,
} from '@/lib/communityHubInventory';

const REMOTE: CommunityHubInventoryPost = {
  title: 'Summer Jazz Night',
  eventType: 'ot',
  description: 'A public jazz performance in the Riverdog barn.',
  extendedDescription: '',
  calendarSourceUrl: 'https://example.org/events?utm_source=mail',
  sessions: [{ start: 1_800_000_000, end: 1_800_003_600 }],
  moderation: 'pending',
};

describe('CommunityHub content inventory', () => {
  it('normalizes both local and CommunityHub session field names', () => {
    expect(normalizeContentSessions([
      { startTime: 20, endTime: 30 },
      { start: 10, end: 15 },
      { start: 10, end: 15 },
    ])).toEqual([
      { start: 10, end: 15 },
      { start: 20, end: 30 },
    ]);
    expect(normalizeContentSessions(JSON.stringify([
      { startTime: 40, endTime: 50 },
    ]))).toEqual([{ start: 40, end: 50 }]);
  });

  it('uses announcement copy to distinguish generic titles with reused windows', () => {
    const announcement = {
      ...REMOTE,
      title: 'Apollo - Coming Soon',
      eventType: 'an',
      description: 'Film A opens Friday.',
      sessions: [{ start: 1_800_000_000, end: 1_900_000_000 }],
    };

    expect(compareEventContent({
      title: 'Apollo - Coming Soon',
      event_type: 'an',
      description: 'Film B opens next month.',
      sessions: JSON.stringify([{ startTime: 1_800_000_000, endTime: 1_900_000_000 }]),
    }, announcement).kind).toBe('none');

    expect(compareEventContent({
      title: 'Apollo - Coming Soon',
      event_type: 'an',
      description: 'Film A opens Friday.',
      sessions: JSON.stringify([{ startTime: 1_800_000_000, endTime: 1_900_000_000 }]),
    }, announcement).kind).toBe('exact');
  });

  it('matches exact content even when the systems use unrelated IDs', () => {
    const match = compareEventContent({
      id: 172,
      title: 'Summer Jazz Night',
      event_type: 'ot',
      description: 'A public jazz performance in the Riverdog barn.',
      calendar_source_url: 'https://example.org/events',
      sessions: [{ startTime: 1_800_000_000, endTime: 1_800_003_600 }],
    } as any, { ...REMOTE, id: 9_999_999 } as any);

    expect(match.kind).toBe('exact');
    expect(match.reasons).toContain('complete session windows');
  });

  it('retains a strongly matching edited listing but not a shared source URL alone', () => {
    expect(findBestContentMatch({
      title: 'Summer Jazz Night at Riverdog',
      event_type: 'ot',
      description: 'Riverdog hosts a public jazz performance in its barn.',
      calendar_source_url: 'https://example.org/events',
      sessions: [{ startTime: 1_800_000_000, endTime: 1_800_004_000 }],
    }, [REMOTE]).kind).toBe('probable');

    expect(findBestContentMatch({
      title: 'Completely Different Concert',
      event_type: 'ot',
      description: 'A different artist and date.',
      calendar_source_url: 'https://example.org/events',
      sessions: [{ startTime: 1_900_000_000, endTime: 1_900_003_600 }],
    }, [REMOTE]).kind).toBe('none');
  });

  it('retains grouped sessions and dates that CommunityHub stores in post copy', () => {
    const grouped: CommunityHubInventoryPost = {
      title: 'Architecture History Walk',
      eventType: 'ot',
      description: 'Find out how the town developed over more than 180 years.',
      extendedDescription: 'Offered Saturday August 15 and Saturdays August 22 and 29.',
      calendarSourceUrl: '',
      timezone: 'America/New_York',
      sessions: [
        { start: 1_786_806_000, end: 1_786_811_400 },
        { start: 1_787_410_800, end: 1_787_416_200 },
      ],
      moderation: 'approved',
    };

    expect(compareEventContent({
      title: 'Architecture History Walk – August Offerings',
      event_type: 'ot',
      description: 'Find out how the town developed over more than 180 years.',
      sessions: [{ startTime: 1_786_806_000, endTime: 1_786_810_500 }],
    }, grouped)).toMatchObject({ kind: 'probable' });

    expect(compareEventContent({
      title: 'Architecture History Walk – August Offerings',
      event_type: 'ot',
      description: 'Find out how the town developed over more than 180 years.',
      sessions: [{ startTime: 1_787_410_800, endTime: 1_787_415_300 }],
    }, { ...grouped, sessions: [grouped.sessions[0]] })).toMatchObject({
      kind: 'probable',
      reasons: expect.arrayContaining(['session date in post content']),
    });
  });

  it('uses a shared local calendar date when remote time data is wrong', () => {
    expect(compareEventContent({
      title: 'Civil War to Civil Rights History Walk – July Offerings',
      event_type: 'ot',
      description: 'A history walk about progress and setbacks in race relations.',
      sessions: [{ startTime: 1_784_386_800, endTime: 1_784_392_200 }],
    }, {
      title: 'Civil War to Civil Rights History Walk',
      eventType: 'ot',
      description: 'A history walk about progress and setbacks in race relations.',
      extendedDescription: '',
      calendarSourceUrl: '',
      timezone: 'America/New_York',
      sessions: [{ start: 1_784_401_200, end: 1_784_406_600 }],
      moderation: 'approved',
    })).toMatchObject({
      kind: 'probable',
      reasons: expect.arrayContaining(['shared session date']),
    });
  });

  it('reads every page and keeps only approved and pending records', async () => {
    const requested: URL[] = [];
    const fetcher = jest.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      requested.push(url);
      const page = Number(url.searchParams.get('page'));
      return new Response(JSON.stringify({
        count: 3,
        unapprovedRecordsCount: 1,
        lastPage: page === 1,
        posts: page === 0
          ? [
            {
              name: 'Approved Event', approved: true, eventType: 'ot',
              description: 'Approved event description.',
              sessions: [{ start: 1_800_000_000, end: 1_800_000_100 }],
            },
            {
              name: 'Rejected Event', approved: false, eventType: 'ot',
              description: 'Rejected event description.',
              sessions: [{ start: 1_800_000_200, end: 1_800_000_300 }],
            },
          ]
          : [{
            name: 'Pending Event', approved: null, eventType: 'ot',
            description: 'Pending event description.',
            sessions: [{ start: 1_800_000_400, end: 1_800_000_500 }],
          }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const inventory = await fetchCommunityHubInventory(fetcher);

    expect(inventory).toMatchObject({ approved: 1, pending: 1, pages: 2, reportedCount: 3 });
    expect(inventory.posts.map(post => post.title)).toEqual(['approved event', 'pending event']);
    expect(requested).toHaveLength(2);
    expect(requested.every(url => url.searchParams.has('allPosts'))).toBe(true);
    expect(requested.map(url => url.searchParams.get('page'))).toEqual(['0', '1']);
  });

  it('retains raw evidence fields on every inventory post', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({
      count: 2,
      unapprovedRecordsCount: 0,
      lastPage: true,
      posts: [
        {
          name: 'Sponsored Concert', approved: true, eventType: 'ot',
          description: 'A concert with named sponsors.',
          calendarSourceName: 'Riverdog Music',
          sponsors: ['Riverdog Music', { name: ' City Parks ' }],
          ingestedPostUrl: 'https://app.example/reviewer/events/158',
          image: 'https://cdn.example/poster.jpg',
          sessions: [{ start: 1_800_000_000, end: 1_800_000_100 }],
        },
        {
          name: 'Bare Event', approved: true, eventType: 'ot',
          description: 'An event with no attribution extras.',
          sessions: [{ start: 1_800_000_200, end: 1_800_000_300 }],
        },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const inventory = await fetchCommunityHubInventory(fetcher);
    const [sponsored, bare] = inventory.posts;

    expect(sponsored.raw).toMatchObject({
      calendarSourceName: 'Riverdog Music',
      sponsors: ['Riverdog Music', 'City Parks'],
      ingestedPostUrl: 'https://app.example/reviewer/events/158',
      hasImage: true,
    });
    expect(bare.raw).toMatchObject({
      calendarSourceName: '',
      sponsors: [],
      ingestedPostUrl: '',
      hasImage: false,
    });
  });

  it('instructs the agent to return every eligible event and leave deduplication to the server', () => {
    expect(COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS).toContain('EVERY eligible event');
    expect(COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS).toContain('server-side');
    expect(COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS).toContain('Do not fetch the CommunityHub inventory');
    expect(COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS).not.toContain('Skip a source event');
  });

  it('refuses to treat a truncated response as deletion evidence', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({
      count: 2,
      unapprovedRecordsCount: 0,
      lastPage: true,
      posts: [{
        name: 'Only one post', approved: true, eventType: 'ot',
        description: 'Only one returned post.',
        sessions: [{ start: 1_800_000_000, end: 1_800_000_100 }],
      }],
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchCommunityHubInventory(fetcher)).rejects.toThrow('truncated');
  });
});
