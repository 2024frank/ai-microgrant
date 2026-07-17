# July 16 calendar meeting — implementation notes

Implemented 2026-07-17. Each numbered item below maps to the confirmed
requirements from the 2026-07-16 Calendar Application Discussion.

## 1. Two-way event comparison and quality tracking

The old design told each agent to fetch the CommunityHub inventory and
silently skip anything that looked like a duplicate, so rejected candidates
left no record. Now:

- Agents return every eligible event (`COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS`
  rewritten; `scripts/sync-agent-contracts.ts --apply` pushes the new contract
  into the managed-agent system prompts).
- `persistExtractedEvents` fetches the complete approved-and-pending
  CommunityHub inventory once per run (5-minute cache) and matches every
  candidate with the existing content matcher. Matches are preserved as
  `raw_events` rows with `status='duplicate'` and a `communityhub_match` JSON
  column carrying the match kind, reasons, the remote post snapshot (including
  whether it was a direct human submission), and field-level differences.
- Every run records a two-way report in `integration_run_comparisons`:
  events found by both sides, integration-only events, and calendar posts
  attributed to the organization (by calendar source name, sponsor, or
  organization) that the integration missed.
- Human review: `/admin/comparisons` (admin UI + `GET /api/admin/comparisons`),
  and the review studio explains preserved duplicates with their diffs.
- Library and Heritage are the intended first evaluation cases: their direct
  submissions surface as `submission_origin: 'direct_submission'` matches.

## 2. Categories ("Spectator Sport") root cause

The payload pipeline does not invent categories; preview and submission read
the same `post_type_ids`. The root cause was historical:
`scripts/fix-agent-prompts.ts` / `fix-agent-prompts-v2.ts` pushed live agent
prompts containing a fabricated taxonomy ("[11] Arts & Culture",
"[15] Music", "[18] Fundraiser"). In the real Oberlin taxonomy 11 is
Spectator Sport and 15/18 do not exist, so an arts event tagged [11] validated
cleanly, previewed as a single innocuous id, and displayed as Spectator Sport.

Fixes: `sync-agent-contracts.ts` rewrites every agent prompt with the correct
id + label contract (run with `--apply` after deploy); reviewer previews now
name every selected category; moderation reconciliation compares the live
post's categories against what was submitted and records drift in
`communityhub_moderation_error` (`category_drift` in the reconcile summary).

## 3-6. Titles and descriptions

- Agent contract (per-run message and canonical system prompt) now requires
  action-oriented announcement titles ("Register for…", "Participate in…",
  "Apply for…", "Recycle…") without inventing unsupported actions.
- Apollo emits exactly "Now Playing at the Apollo" and
  "Coming Soon to the Apollo"; the upcoming/current segmenter is unchanged.
  Live posts with the old titles are matched as duplicates until their
  windows end, so nothing double-posts during the transition.
- `src/lib/contentPolicy.ts` enforces deterministically at ingestion:
  registration URL into the Register button, short description ends with
  "Registration required."; cost evidence adds "Paid event."; long
  descriptions lose URLs and the event address; a long description that fits
  the 200-character short field replaces it and is dropped; ambiguous
  "here/there" location wording is flagged for the reviewer (never rewritten).
- Apollo's feed no longer writes URLs or the street address into the long
  description; the ticket link stays in the button and the venue page in
  `website`.

## 7. Long-description optionality

See `docs/long-description-optionality.md`: CommunityHub documents the field
as optional and the live feed contains a post without one; our payloads omit
it when empty and no view renders an empty heading. The draft email to Peter
(cc John) is prepared there and is only needed if a real submission fails on
the field.

## 8. Image failures

Root cause: the poster proxy re-fetched the original third-party image at the
moment CommunityHub downloaded the poster; expired or hotlink-protected URLs
became "failed to download image from URL". Approval now materializes the
remote image into stored bytes; a download failure is an immediate 422
(`image_download_failed`, with the SafeImageError code) before CommunityHub is
contacted. CommunityHub error responses are classified
(`communityhub_image_download` vs `communityhub_validation` vs
`communityhub_error`) in API responses and stored submission errors. Signed
poster URLs remain valid across the post's moderation states, and the poster
routes have an explicit serverless duration budget.

## 9-11. Source metadata, provenance, priority

- `sources` gains `org_sponsor_name`, `org_website`, `org_phone`,
  `org_contact_email`, and `source_kind` (`original_org` | `aggregator`);
  editable via `PATCH /api/sources/:id`, backfillable via
  `scripts/set-source-org-metadata.ts --apply`. Ingestion stamps the sponsor
  of record and fills missing contact fields.
- Event APIs and the review studio show where a record came from
  (`collected_via`: original organization, aggregator, or organization
  email); direct human submissions are visible in comparison reports.
- Priority: the scheduler dispatches original-organization sources before
  aggregators, and an aggregator candidate matching a more direct source's
  event is preserved as a cross-source duplicate instead of re-entering
  review. (No Localist source exists yet; the mechanism is ready for one.)

## 12. Required-field behavior

Geographic scope stays optional. Contract-invalid drafts (any `required` or
`too_short` issue) are rejected at ingestion as "Required fields are missing"
(`rejection_log` origin `system`, reasons preserved) and requeued once through
the existing correction workflow by `/api/agent/system-corrections` (invoked
from the scheduler). Corrections must reference the original via
`fixedFromEventId`, so retries cannot create duplicates.

## Verification

56 jest suites / 553 tests, `tsc --noEmit` clean, eslint clean, production
build passes. Migration `0018_run_comparisons_and_source_metadata.sql`
applies automatically on production deploy.

## Known limitations (reviewed and accepted)

- When the CommunityHub inventory is unreachable during a run, candidates
  ingest as normal pending drafts (never silently dropped); the comparison row
  records `inventory_unavailable`, but the review studio itself does not warn
  that duplicate matching was skipped for those drafts.
- Source priority is deterministic at ingestion (aggregator candidates defer
  to existing original-organization events), but scheduling order within a
  single dispatch tick is best-effort: runs execute in the background, so an
  aggregator that ingests before the original in the same tick can produce
  one extra pending copy for the reviewer. No aggregator source exists yet.
- A probable CommunityHub match without temporal evidence goes to review with
  its match evidence attached instead of being auto-suppressed; reviewers make
  the final duplicate call for recurring events.
- Live Apollo posts created with the old titles keep them until their windows
  end; new windows publish with the exact agreed titles.

## Explicitly out of scope (discussed, not confirmed)

Undo/revert after edits; dedicated paid/registration frontend tags; Cleveland
neighborhood filtering; Oriana House email ingestion; CommunityHub changes
beyond optional long descriptions; automatic learning from comparison data
(the data is stored; any learning mechanism is a separate proposal).
