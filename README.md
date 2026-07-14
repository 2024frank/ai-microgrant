# Oberlin Community Calendar Ingestion

An open-source event-ingestion and human-review platform for community calendars. Source-specific Anthropic agents extract candidate events, the application validates every field against Oberlin CommunityHub's payload contract, and reviewers decide what is published.

AI output is treated as untrusted input. The system does not retrain a model or publish autonomously: deterministic validation, source-scoped reviewer feedback, and a human approval step remain in the loop.

## What it does

```text
Source calendar or mailbox
        |
        v
Anthropic source agent
        |
        v
Normalize + validate payload ----> field-level issues
        |                                  |
        +------------ review queue <-------+
                         |
             edit / reject / request fix
                         |
                      approve
                         |
                         v
                Oberlin CommunityHub
```

- Runs web and email sources on independent five-field cron schedules.
- Prevents overlapping runs and duplicate schedule-slot claims at the database layer.
- Normalizes extraction output once, at ingestion, and validates it again before publication.
- Keeps fixable drafts visible with exact field-level errors; one malformed item cannot roll back a whole batch.
- Gives reviewers a responsive queue, detailed review workspace, readiness checks, and source-scoped access.
- Gives administrators source health, recent run errors, next-run estimates, queue pressure, and manual controls.
- Records rejections and edits as durable feedback evidence without claiming autonomous model training.
- Publishes with a durable payload hash so a retry can recover local state without creating a duplicate CommunityHub post.

## CommunityHub payload contract

Publication targets:

```text
https://oberlin.communityhub.cloud/api/legacy/calendar/post/submit
```

The public calendar feed documented for this project is:

```text
https://oberlin.communityhub.cloud/api/legacy/calendar/posts
```

The canonical builder and validator live in `src/lib/communityHubPayload.ts`. Both camelCase agent input and snake_case database rows pass through it.

Required rules:

- `eventType` is only `ot` (event), `an` (announcement), or `jp` (job). Values such as class, exhibit, workshop, performance, or meeting are categories and belong in `postTypeId`.
- `title` is 1–60 characters.
- `description` is 10–200 characters; `extendedDescription` is at most 1,000 characters.
- `email` is valid, and `sponsors`, `postTypeId`, and `sessions` are non-empty arrays.
- Session `startTime` and `endTime` are positive Unix timestamps in seconds; the end cannot precede the start.
- `locationType` is `ph2`, `on`, `bo`, or `ne`. Physical/hybrid events require `location`; online/hybrid events require `urlLink`.
- `display` is `all`, `ps`, `sps`, or `ss`. `ss` requires at least one screen ID.
- Optional email, phone, and URL fields are validated before publication.

Allowed Oberlin category IDs:

| ID | Category | ID | Category |
|---:|---|---:|---|
| 1 | Volunteer Opportunity | 9 | Theatre or Dance |
| 2 | Exhibit | 10 | City Government |
| 3 | Fair, Festival, or Public Celebration | 11 | Spectator Sport |
| 4 | Tour, Walking Tours or Open House | 12 | Participatory Sport or Game |
| 5 | Film | 13 | Networking Event |
| 6 | Presentation or Lecture | 59 | Ecolympics or Environmental |
| 7 | Workshop or Class | 89 | Other |
| 8 | Music Performance |  |  |

Legacy category-like event-type codes are migrated to `ot`; new unknown values are rejected by validation instead of being sent downstream.

## Feedback policy

`src/lib/rejectionHistory.ts` implements `feedback-policy/v1`.

- Reviewer notes are sanitized, bounded, and explicitly labeled as untrusted examples.
- Recent corrections are examples, not instructions.
- Only allow-listed source-wide fields can become a high-confidence default.
- A default requires the same canonical value across at least three distinct events.
- Conflicting repeated values suppress promotion.
- Event-specific facts—including title, description, sessions, location, and event type—are never promoted to source-wide rules.
- Current source evidence always wins, and every result still requires review.

This is persistent prompt context, not fine-tuning, weight updates, reinforcement learning, or a guarantee that the underlying model improves.

## Scheduling and run safety

GitHub Actions calls `/api/agent/schedule` hourly at minute 17. The dispatcher evaluates every active source's five-field cron expression in `America/New_York`, dispatches only due sources, and reports invalid schedules without running them. Vercel also makes one daily safety invocation, which remains compatible with Hobby-plan cron limits.

The per-source trigger then:

1. recovers an expired run lease;
2. atomically claims a running-source and schedule-slot lease;
3. returns `409` for duplicate/concurrent claims;
4. runs the agent with Next.js `after()`;
5. records completion or a bounded error log.

Manual admin triggers use the same lease path. Direct agent posts to `/api/ingest/:slug` attach to an existing source run when present instead of creating a competing lease.

Set independent, non-empty `CRON_SECRET`, `INGEST_SECRET`, and `MEDIA_PROXY_SECRET` values. Scheduler requests use `Authorization: Bearer <CRON_SECRET>`; internal per-source dispatch uses `x-cron-secret`; ingestion uses `x-ingest-secret`. `MEDIA_PROXY_SECRET` signs the short-lived poster URL CommunityHub retrieves while a draft is in the `publishing` state.

## Stack

| Layer | Technology |
|---|---|
| Web application | Next.js 16.2 App Router, React 19, TypeScript |
| Database | MySQL 8 with `mysql2` |
| Extraction | Anthropic managed-agent Sessions API |
| Authentication | Firebase Authentication and Firebase Admin |
| Mail | SMTP/IMAP, with optional Resend integration |
| Deployment | Vercel plus GitHub Actions |
| Testing | Jest, ts-jest, ESLint, Next production build |

## Local setup

Requirements: Node.js 22, npm, and MySQL 8.

```bash
git clone <your-fork-url>
cd ai-microgrant
npm ci
npm run setup
```

`npm run setup` copies `.env.example` to `.env.local` without overwriting an existing file. Fill in the values, then run:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

The application is available at `http://localhost:3000` by default.

Never commit `.env.local`, Firebase service-account JSON, database credentials, API keys, or scheduler/ingest secrets. Only variables prefixed with `NEXT_PUBLIC_` are safe to expose to browser code.

## Database migrations

Migrations are ordered SQL files under `migrations/` and tracked by `schema_migrations`.

```bash
npm run db:migrate:status
npm run db:migrate
```

Notable contract/safety migrations:

- `0007_oberlin_payload_contract.sql` backfills legacy event/display values and narrows enums.
- `0008_scheduler_leases.sql` adds retry-safe scheduler columns and unique run leases.
- `0009_ingestion_quality.sql` adds reviewable validation errors, correction lineage, safe publishing states, and durable outbound submissions.
- `0010_correction_run_integrity.sql` binds correction runs to one exact original event and indexes that relationship.

The newer DDL is guarded through `INFORMATION_SCHEMA` where additive changes could be partially committed by MySQL, so deployment retries are safe.

## Core API routes

| Route | Access | Purpose |
|---|---|---|
| `GET /api/agent/schedule` | `CRON_SECRET` | Hourly due-source dispatcher |
| `POST /api/agent/trigger/:source_id` | admin or internal secret | Claim and start one source run |
| `POST /api/ingest/:slug` | `INGEST_SECRET` | Submit extracted event candidates |
| `GET /api/review/queue` | reviewer/admin | Paginated review queue |
| `GET /api/review/events/:id` | assigned reviewer/admin | Full review record |
| `POST /api/review/events/:id/action` | assigned reviewer/admin | Approve or reject |
| `POST /api/review/events/:id/send-for-correction` | reviewer/admin | Request a corrected draft |
| `GET/POST /api/sources` | admin | Source operations and creation |
| `PATCH /api/sources/:id` | admin | Update and validate source configuration |
| `POST /api/cleanup` | `CRON_SECRET` | Remove abandoned drafts and old poster blobs while preserving feedback |

The ingest response includes inserted/skipped counts plus `needs_review` and field-level `validation_errors`. Invalid but fixable drafts stay in the queue; drafts without truthful core content are skipped.

## Verification

Run the same checks expected in CI:

```bash
npm test -- --runInBand
npx tsc --noEmit
npm run lint
npm run build
```

For a read-only production source audit, use:

```bash
npx tsx scripts/audit-sources.ts
```

That command requires production credentials and should never be run from an untrusted environment.

## Deployment

1. Create a MySQL 8 database and configure all required variables from `.env.example` in the deployment environment.
2. Run `npm run db:migrate` against the target database.
3. Seed or create at least one active admin.
4. Deploy the Next.js application.
5. Configure the repository's `APP_URL` and `CRON_SECRET` Actions secrets. `.github/workflows/fetch.yml` runs the dispatcher hourly at minute 17.
6. Keep the daily Vercel safety invocation from `vercel.json`; hourly Vercel Cron requires a Pro plan.
7. Create sources with valid agent IDs and five-field cron expressions.
8. Trigger one source manually, inspect its run record, review a draft, and verify a test submission before enabling all schedules.

The dispatcher is hourly and scans the preceding 60-minute window. A non-zero minute is therefore honored but may start up to 59 minutes after its exact cron time; multiple occurrences for one source inside the same window are coalesced to the latest slot. Increase the platform dispatcher frequency if exact-minute starts are required.

## Contributing

Issues and pull requests are welcome. Keep changes narrowly scoped, add tests for failure paths, and do not weaken authorization or payload validation for convenience. When changing Next.js behavior, read the versioned guides under `node_modules/next/dist/docs/` because this repository intentionally follows Next.js 16 conventions.

## License

MIT. See [LICENSE](LICENSE).
