# Plan: durable agent execution (fix stuck / never-run sources)

## The problem (observed live)
`triggerAgentRun` long-polls the Anthropic Sessions API for up to **30 minutes**,
and `/api/agent/schedule` `await`s each source's run **sequentially**. Both run
inside Vercel **serverless functions**, which are killed at the platform timeout
(seconds, not minutes). Consequences seen in the source audit:

- **Oberlin College** accumulated **3 runs stuck in `running`** (Jun 20/26/27) —
  killed mid-poll, never marked done. (Recovered via `scripts/recover-stuck-runs.ts`.)
- **Library** and **Heritage Center** have **never run** — the schedule loop dies
  on the first source, so later ones never start.
- Manual `/api/agent/trigger` and the fix-agent use fire-and-forget
  `import().then()` with no `waitUntil`, so the background work isn't guaranteed
  to survive after the response returns either.

## Root cause
Long-running work (a 30-min poll) cannot live in a request/response serverless
handler. It needs a durable execution context.

## Recommended fix — a durable job runner
Move agent runs off the request path:

1. `/api/agent/schedule` (cron) **enqueues one job per due source** and returns
   immediately — no long work in the handler.
2. A **durable worker** executes each job (the Sessions long-poll), independent
   of any HTTP timeout, with retries and per-job status.

Options, easiest first:
- **Inngest** — durable step functions, no per-step timeout, retries, great
  Vercel fit. The poll loop becomes a step. Lowest-effort for the 30-min case.
- **QStash (Upstash)** — HTTP message queue; enqueue per source, a worker route
  processes one source per delivery (pair with a webhook/callback model so no
  single invocation holds 30 min).
- **Dedicated worker** — a small always-on Node process / container / VM cron
  that claims due sources and runs the polls. Most control, most ops.

A cleaner long-term variant: switch the agent from **long-poll → webhook/callback**
so the platform never holds a connection open — the Sessions run notifies an
endpoint on completion.

## Interim mitigations (until the worker lands)
- **`scripts/recover-stuck-runs.ts`** as a janitor (run on a schedule) to fail
  zombie `running` rows so sources aren't blocked. *(added)*
- **Per-source schedules** now spread load across days, so fewer sources pile up
  in a single schedule invocation. *(added — `lib/schedule.ts`)*
- Set `export const maxDuration = 300` on the agent routes (Vercel Pro) — buys 5
  minutes; enough for light sources, not for the 30-min worst case.

## Where this fits
This is **Phase 2** of `PRODUCT-PLAN.md` (durable job/worker) — and it should be
applied to the live Oberlin deployment too, since it's actively dropping runs.
