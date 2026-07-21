<p align="center">
  <img src="public/logo.png" alt="CommunityHub AI Calendar" width="104" />
</p>

# AI Calendar

AI Calendar helps a local calendar team find public event information, turn it into a consistent draft, and send it through the same human review process used for community submissions.

The software is open source because this is civic infrastructure. Communities should be able to see how it works, question its decisions, adapt it to local needs, and keep people responsible for what ultimately gets published.

## Why we built this

Local event information is everywhere and nowhere at the same time. A college, city government, library, theater, museum, neighborhood group, and small business may all maintain their own calendars. Each one uses different fields, categories, layouts, and levels of detail. Even when an event is public, people will miss it unless they already know where to look.

Oberlin has been working on this problem for more than a decade. At the request of the Oberlin Business Partnership, the Environmental Dashboard team created a crowdsourced Community Calendar where residents and organizations can submit events. Once approved, those events can appear on CommunityHub websites, 23 Community Dashboard displays around town, and in a weekly newsletter.

That system works, but it still depends on people cross-posting information from many separate calendars. Traditional scrapers are brittle here: a script written for one site usually breaks on the next one, and even a small redesign can stop it from working.

This project asks a practical question: can current language models help with the repetitive work of reading those different sources without taking judgment away from the people who maintain the calendar?

The goal is not to let a model run a public calendar. The goal is to give reviewers a better first draft.

## Where the project came from

The project grew out of an Oberlin College AI Micro-Grant application developed by student researcher Frank Kusi Appiah and Professor John Petersen. It continues a faculty–student collaboration focused on community information systems, responsible uses of AI, and learning through building and evaluation.

The pilot began with event sources such as Oberlin College and Conservatory, the City of Oberlin, the Apollo Theatre, the Allen Memorial Art Museum, the Oberlin Public Library, the Oberlin Heritage Society, FAVA, and the Oberlin Business Partnership. These organizations were chosen because they publish useful public information in very different ways.

We are using the project to study:

- how accurately a model can extract dates, times, recurrence, locations, descriptions, organizers, and categories from varied public sources;
- which mistakes recur, and which fields still require the most human correction;
- whether assisted intake actually saves time without lowering trust or accuracy;
- how duplicate announcements can be detected before they reach the calendar;
- how feedback from reviewers can improve a source-specific workflow without being mistaken for model training; and
- whether public information can eventually be tagged by geographic relevance, from a neighborhood to a city, county, or region.

That last question matters beyond Oberlin. The Environmental Dashboard team also supports community information projects in Cleveland, where a display may need to mix hyper-local neighborhood content with information relevant across a ward, city, or region. Geographic classification is part of the research direction; it should not be read as a finished feature of this repository.

### How we will know whether it is useful

The pilot is not successful merely because the software can produce a calendar entry. We are comparing proposed records with human-verified entries and looking at field accuracy, missing information, duplicate detection, recurring failure patterns, and the amount of correction required before approval. We also want to know whether the system brings a wider range of community events into one calendar and whether a small team can maintain it responsibly over time.

The educational side matters too. Frank and John are using the work to learn together: testing current agent tools, documenting their limits, and thinking through the governance choices that appear when AI is used in public-facing civic infrastructure.

## How it works

```text
Public calendar, webpage, document, or mailbox
                        |
                        v
              Source-specific agent
                        |
                        v
             Normalize and validate
                        |
                        v
                  Review queue
               /       |        \
            edit     reject    request a fix
               \       |        /
                        v
                 Human approval
                        |
                        v
             Oberlin CommunityHub
```

Each source has its own instructions and schedule. The agent proposes structured event records, but the application treats that output as untrusted. It normalizes the fields, checks them against CommunityHub's publishing contract, and shows reviewers exactly what is incomplete or invalid.

Reviewers can edit a draft, reject it, or send it back for a source-backed correction. Nothing is published until a person approves it.

## What is in the application today

- Independent web and email sources with five-field cron schedules.
- A review queue that keeps fixable drafts visible instead of silently dropping them.
- Field-level validation before review and again before publication.
- Source-scoped reviewer access, detailed review pages, and readiness checks.
- Admin views for source health, recent failures, next-run estimates, queue pressure, and manual controls.
- Duplicate-run and schedule-slot protection at the database layer.
- Durable records of edits, rejections, correction requests, and publication attempts.
- Retry-safe CommunityHub publishing using a payload hash, so a recovered request does not create a duplicate post.

## Human review is part of the design

This project only reads information that organizations have made public for public participation. It does not need private calendars or restricted data.

Every proposed item stays subject to human review. That is not a temporary guardrail we plan to remove. Public calendars affect where people go, what they know about, and which organizations receive attention. A plausible but invented time or address can waste someone's evening. Source credit, visible uncertainty, and a clear audit trail matter as much as extraction speed.

We also want the failures. The pilot is meant to document where assisted extraction works, where it fails, and how much review it still requires. Those results are more useful than pretending the system is autonomous.

## CommunityHub publishing contract

Approved records are sent to:

```text
https://oberlin.communityhub.cloud/api/legacy/calendar/post/submit
```

The public calendar feed used by this project is:

```text
https://oberlin.communityhub.cloud/api/legacy/calendar/posts
```

The canonical payload builder and validator are in `src/lib/communityHubPayload.ts`. Agent output and database rows both pass through that module before anything can be published.

Important rules include:

- `eventType` is `ot` (event), `an` (announcement), or `jp` (job). Workshop, performance, exhibit, and similar values are categories and belong in `postTypeId`.
- Titles are 1–60 characters.
- Short descriptions are 10–200 characters; extended descriptions may be up to 1,000 characters.
- Email addresses must be valid, and `sponsors`, `postTypeId`, and `sessions` cannot be empty.
- Session times are positive Unix timestamps in seconds. An end time cannot precede its start time, and publication requires at least one current or future session.
- `locationType` is `ph2`, `on`, `bo`, or `ne`. Physical and hybrid events need a location; online and hybrid events need a URL.
- `display` is `all`, `ps`, `sps`, or `ss`. Screen-specific posts need at least one screen ID.
- Optional phone, email, and URL fields are still validated when supplied.

Supported Oberlin category IDs:

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

Legacy category-like event types are migrated to `ot`. New unknown values are rejected rather than guessed at publication time.

## What reviewer feedback does

`src/lib/rejectionHistory.ts` implements `feedback-policy/v1`.

Reviewer corrections can be included as source-specific examples in a later correction request, but they are sanitized, length-limited, and clearly labeled as untrusted context. They do not retrain a model, update model weights, or guarantee that a model has “learned.”

Only a small allow-list of source-wide fields can become suggested defaults. A value must appear consistently across at least three different events, and conflicting examples prevent promotion. Event-specific facts such as titles, dates, descriptions, locations, and sessions never become source defaults. Current source evidence always takes priority, and the result still returns to a reviewer.

Rejected records remain in the audit trail. A correction request archives the rejected original and creates a separate pending replacement only when a source-backed correction succeeds. Failed or abandoned correction jobs restore the original review state so the request can be tried again.

## Scheduling and run safety

GitHub Actions calls `/api/agent/schedule` once an hour at minute 17. The dispatcher evaluates each active source's cron schedule in `America/New_York` and looks back six hours so a delayed Actions run does not silently lose a scheduled source.

Before starting work, the application claims both the source and the exact schedule slot. Duplicate or overlapping claims receive a `409`, and stale leases are recoverable. Manual admin runs use the same path instead of bypassing those protections. Vercel makes one additional daily safety call that is compatible with Hobby-plan cron limits.

Use separate, non-empty values for `CRON_SECRET`, `INGEST_SECRET`, and `MEDIA_PROXY_SECRET`:

- Scheduler requests use `Authorization: Bearer <CRON_SECRET>`.
- Internal source dispatch uses `x-cron-secret`.
- Agent ingestion uses `x-ingest-secret`.
- `MEDIA_PROXY_SECRET` signs short-lived poster URLs while a draft is being published.

## Technology

| Layer | Technology |
|---|---|
| Application | Next.js 16.2 App Router, React 19, TypeScript |
| Database | MySQL 8 with `mysql2` |
| Extraction | Anthropic managed-agent Sessions API |
| Authentication | Firebase Authentication and Firebase Admin |
| Mail ingestion and notifications | SMTP/IMAP, with optional Resend integration |
| Deployment | Vercel and GitHub Actions |
| Tests | Jest, ts-jest, ESLint, and the Next.js production build |

## Run it locally

You will need Node.js 22, npm, and MySQL 8.

```bash
git clone <your-fork-url>
cd ai-microgrant
npm ci
npm run setup
```

`npm run setup` copies `.env.example` to `.env.local` without overwriting an existing file. Add the required values, then run:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

The development server uses `http://localhost:3000` by default.

Never commit `.env.local`, Firebase service-account JSON, database credentials, API keys, or scheduler and ingestion secrets. Only values beginning with `NEXT_PUBLIC_` are safe to expose to browser code.

## Database migrations

Migrations are ordered SQL files in `migrations/` and recorded in `schema_migrations`.

```bash
npm run db:migrate:status
npm run db:migrate
```

Several early migrations established the current safety model:

- `0007_oberlin_payload_contract.sql` normalizes legacy event and display values and narrows their enums.
- `0008_scheduler_leases.sql` adds retry-safe scheduler fields and unique run leases.
- `0009_ingestion_quality.sql` adds reviewable validation errors, correction lineage, safe publishing states, and durable submissions.
- `0010_correction_run_integrity.sql` ties a correction run to one exact original event.

Later migrations extend the application and should be applied in order. Additive DDL uses `INFORMATION_SCHEMA` guards where MySQL could otherwise leave a partially applied change.

## Main API routes

| Route | Access | Purpose |
|---|---|---|
| `GET /api/agent/schedule` | `CRON_SECRET` | Find and dispatch due sources |
| `POST /api/agent/trigger/:source_id` | Admin or internal secret | Claim and start one source run |
| `POST /api/ingest/:slug` | `INGEST_SECRET` | Submit extracted event candidates |
| `GET /api/review/queue` | Reviewer or admin | Read the review queue |
| `GET /api/review/events/:id` | Assigned reviewer or admin | Read a full review record |
| `POST /api/review/events/:id/action` | Assigned reviewer or admin | Approve or reject a draft |
| `POST /api/review/events/:id/send-for-correction` | Reviewer or admin | Request a corrected draft |
| `GET/POST /api/sources` | Admin | List or create sources |
| `PATCH /api/sources/:id` | Admin | Update and validate a source |
| `POST /api/cleanup` | `CRON_SECRET` | Remove abandoned drafts and old poster data while preserving feedback |

Ingestion responses include inserted and skipped counts, `needs_review`, and field-level `validation_errors`. Fixable drafts remain visible. Records without truthful core event information are skipped.

## Check your changes

Run the same checks used by the project before opening a pull request:

```bash
npm test -- --runInBand
npx tsc --noEmit
npm run lint
npm run build
```

For a read-only audit of configured production sources:

```bash
npx tsx scripts/audit-sources.ts
```

That command requires production credentials and should only be run from a trusted environment.

Pending-event validation and managed-agent contract synchronization are dry runs unless `--apply` is supplied:

```bash
npm run events:revalidate
npx tsx scripts/sync-agent-contracts.ts
```

Review the report before using `--apply`. Neither command should print prompt bodies or secret values.

## Deploying the application

1. Create a MySQL 8 database and configure the variables listed in `.env.example`.
2. Run `npm run db:migrate` against that database.
3. Seed or create at least one active administrator.
4. Deploy the Next.js application.
5. Add `APP_URL` and `CRON_SECRET` to the repository's Actions secrets.
6. Keep the daily Vercel safety invocation from `vercel.json`. Hourly Vercel Cron requires a Pro plan.
7. Create sources with valid agent IDs and five-field cron expressions.
8. Run one source manually, inspect its run record, review a draft, and confirm a test submission before enabling every schedule.

The hourly dispatcher coalesces multiple missed occurrences for the same source to the latest slot in its six-hour window. If exact-minute starts matter, increase the dispatcher frequency on the hosting platform.

## Contributing

Issues and pull requests are welcome, especially reports from people working on community calendars or other public-interest information systems.

Please keep changes focused, add tests for failure paths, and do not weaken authorization, source attribution, human review, or payload validation for convenience. This repository follows Next.js 16 conventions; read the versioned guides in `node_modules/next/dist/docs/` before changing framework behavior.

## Project team

This project is being developed by Frank Kusi Appiah and John Petersen through an Oberlin College faculty–student collaboration with the Environmental Dashboard and CommunityHub work.

## License

MIT. See [LICENSE](LICENSE).
