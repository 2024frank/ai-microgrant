-- The first Locable library run (agent_run 450) built events from the index
-- cards alone: no images and no per-event detail URL, so the sweep could not
-- recover images either. The agent contract now requires opening each
-- program's detail page and setting the detail URL as the source. Remove that
-- imageless batch so the corrected re-run is not deduplicated against it.
-- Precisely scoped to that one run and to still-pending, unreviewed drafts.
DELETE FROM raw_events
WHERE source_id = 7
  AND agent_run_id = 450
  AND status = 'pending';
