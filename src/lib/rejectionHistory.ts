import pool from './db';

export async function getRejectionHistory(sourceId: number, limit = 50) {
  const [rows] = await pool.query(
    `SELECT event_title, reason_codes, reviewer_note, created_at
     FROM rejection_log WHERE source_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [sourceId, limit]
  ) as any;

  if (!rows.length) return { count: 0, prompt_block: '' };

  const lines = rows.slice(0, 20).map((r: any) => {
    // reason_codes is a JSON column — mysql2 may return it already parsed
    const parsed = Array.isArray(r.reason_codes) ? r.reason_codes : JSON.parse(r.reason_codes);
    const codes = parsed.join(', ');
    const note  = r.reviewer_note ? ` — "${r.reviewer_note}"` : '';
    return `- "${r.event_title}" → REJECTED: ${codes}${note}`;
  });

  const prompt_block = `
## Rejection history for this source — learn from these

${lines.join('\n')}

### Reason codes
- wrong_audience: restricted to staff/students only — skip it
- bad_date_parse: date/time extracted incorrectly
- duplicate_missed: already in CommunityHub — deduplicate more carefully
- description_hallucinated: added details not in source text — stay faithful
- missing_fields: required fields left empty
- wrong_geo_scope: geographic scope tagged incorrectly
- not_public_event: private or invitation-only
- wrong_post_type: postTypeId category incorrect
- bad_location: location missing or wrong
`.trim();

  return { count: rows.length, prompt_block };
}
