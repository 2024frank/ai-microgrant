-- ============================================================
-- 0005_agent_session_id — store the Anthropic session id per run
-- ============================================================
-- "Stop" currently only flips agent_runs.status to 'stopped' — the Anthropic
-- session keeps running API-side (the SDK has no cancel; delete is the only
-- teardown). Storing the session id lets the stop route delete the session so
-- the agent actually stops. Best-effort everywhere, so this degrades gracefully
-- until applied.
-- ============================================================

ALTER TABLE agent_runs ADD COLUMN session_id VARCHAR(120) NULL;
