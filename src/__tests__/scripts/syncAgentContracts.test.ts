import {
  assertSafePrompt,
  sanitizeSourceInstructions,
} from '../../../scripts/sync-agent-contracts';

describe('managed-agent contract synchronization', () => {
  const originalSecret = process.env.INGEST_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INGEST_SECRET;
    else process.env.INGEST_SECRET = originalSecret;
  });

  it('removes direct posting and legacy field rules without deleting source behavior', () => {
    const sanitized = sanitizeSourceInstructions(`You review the current public calendar.

## STEP 1 — Browse
GET https://example.org/events
Keep sponsors named by the source and display sold-out status in the description.
Split multi-session festivals into the sessions stated on each detail page.
- eventType: "ev"
- sessions: ISO 8601 values; estimate a two-hour end time.
- postTypeId: [15] Music

## STEP 2 — POST
POST https://ai-microgrant-research-oberlin.vercel.app/api/ingest/example
Headers: { "x-ingest-secret": "secret-value" }
Return only current public events.`);

    expect(sanitized).toContain('https://example.org/events');
    expect(sanitized).toContain('Keep sponsors named by the source');
    expect(sanitized).toContain('Split multi-session festivals');
    expect(sanitized).not.toContain('eventType: "ev"');
    expect(sanitized).not.toContain('ISO 8601');
    expect(sanitized).not.toContain('/api/ingest/');
    expect(sanitized).not.toContain('secret-value');
  });

  it('preserves an already-migrated source section exactly', () => {
    const source = `Browse https://example.org/events.\nKeep sponsors named by the source and preserve source-specific filters. ${'x'.repeat(30)}`;
    expect(sanitizeSourceInstructions(
      `## Current extraction and handoff contract — highest priority\n\n## Source-specific instructions for Example\n\n${source}\n\nReturn only the JSON array.`,
    )).toBe(source);
  });

  it('rejects the configured ingest secret even when it has no header label', () => {
    process.env.INGEST_SECRET = 'configured-secret-value';
    expect(() => assertSafePrompt(`
eventType: only "ot"
never use em dashes
sponsors: non-empty string array
postTypeId: non-empty number array
8 Music Performance
59 Ecolympics or Environmental
locationType: "ph2" physical
display: "all" all public screens
integer Unix seconds
Return only one raw JSON array
${process.env.INGEST_SECRET}
    `)).toThrow('configured ingest secret');
  });
});
