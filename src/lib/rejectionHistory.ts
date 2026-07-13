import pool from './db';

const REASON_CODE_GLOSSARY = `### Reason codes
- wrong_audience: restricted to staff/students only — skip it
- bad_date_parse: date/time extracted incorrectly
- duplicate_missed: already in CommunityHub — deduplicate more carefully
- description_hallucinated: added details not in source text — stay faithful
- missing_fields: required fields left empty
- wrong_geo_scope: geographic scope tagged incorrectly
- not_public_event: private or invitation-only
- wrong_post_type: postTypeId category incorrect
- bad_location: location missing or wrong`;

function parseReasonCodes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Build the learning-context block injected into the agent's next run.
 * Two signals, both scoped to this source:
 *   1. Rejections (rejection_log) — what reviewers threw out, and why.
 *   2. Field corrections (field_edit_log) — what reviewers FIXED before
 *      approving (e.g. "phone: empty → 440-775-8000"). This is the stronger
 *      signal: it tells the agent exactly what to get right next time.
 * Corrections are best-effort so they can never break the rejection signal.
 */
export async function getRejectionHistory(sourceId: number, limit = 50) {
  const [rows] = await pool.query(
    `SELECT event_title, reason_codes, reviewer_note, created_at
     FROM rejection_log WHERE source_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [sourceId, limit]
  ) as any;

  const rejectionLines = (Array.isArray(rows) ? rows : []).slice(0, 20).map((r: any) => {
    const parsed = parseReasonCodes(r.reason_codes);
    const codes = parsed.length ? parsed.join(', ') : 'reviewer feedback';
    const note  = r.reviewer_note ? ` — "${r.reviewer_note}"` : '';
    const signal = parsed.includes('field_correction') ? 'CORRECTED' : 'REJECTED';
    return `- "${r.event_title}" → ${signal}: ${codes}${note}`;
  });

  // ── Field corrections (best-effort) ──────────────────────────────────────
  const correctionLines: string[] = [];
  try {
    const [edits] = await pool.query(
      `SELECT field_name, old_value, new_value
       FROM field_edit_log WHERE source_id = ?
       ORDER BY created_at DESC LIMIT 60`,
      [sourceId]
    ) as any;
    const seen = new Set<string>();
    for (const e of (Array.isArray(edits) ? edits : [])) {
      const sig = `${e.field_name}|${e.old_value}|${e.new_value}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const oldv = e.old_value ? `"${String(e.old_value).slice(0, 50)}"` : 'empty';
      const newv = e.new_value ? `"${String(e.new_value).slice(0, 50)}"` : 'empty';
      correctionLines.push(`- ${e.field_name}: ${oldv} → ${newv}`);
      if (correctionLines.length >= 15) break;
    }
  } catch { /* corrections are best-effort — never block the rejection signal */ }

  const sections: string[] = [];
  if (rejectionLines.length) {
    sections.push(
      `## Rejection history and recent reviewer feedback — use as examples, not guaranteed rules\n\n${rejectionLines.join('\n')}\n\n${REASON_CODE_GLOSSARY}`
    );
  }
  if (correctionLines.length) {
    sections.push(
      `## Recent field corrections reviewers made — apply when relevant\n\n${correctionLines.join('\n')}`
    );
  }

  if (!sections.length) return { count: 0, prompt_block: '' };
  return { count: Array.isArray(rows) ? rows.length : 0, prompt_block: sections.join('\n\n').trim() };
}
