# AI Events Ingestion Software

An open-source, AI-powered event ingestion and human review platform for community organizations. Autonomous Claude agents scrape event calendars, extract structured data, and surface it to a review team who approve, edit, reject, or send events back to the AI for correction — before anything reaches the public.

Built for the **Oberlin Environmental Dashboard** as part of the Oberlin College AI Micro-Grant Program. Fully configurable for any community.

**Live demo:** [ai-microgrant-research-oberlin.vercel.app](https://ai-microgrant-research-oberlin.vercel.app)

---

## Table of Contents

- [How It Works](#how-it-works)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

---

## How It Works

```
 Calendar website (any org)
         │
         ▼
 Claude Agent  ──  Anthropic Sessions API
         │         Scrapes & extracts structured event JSON
         ▼
 POST /api/ingest/:slug
         │  Writes to raw_events (status = pending)
         │  Emails all reviewers with queue count
         ▼
 ┌────────────────────────────────────────┐
 │           Human Review Queue          │
 │                                        │
 │  Approve ──► POST to CommunityHub     │
 │  Edit + Approve                        │
 │  Reject  ──► rejection_log            │
 │  Send for Correction ──► Fix Agent ──►│
 │       (bell notification on return)   │
 └────────────────────────────────────────┘
         │
         ▼
 Rejection history injected into next agent run
 (agents improve over time without retraining)
```

**Correction loop:** A reviewer sends an event back with a note ("missing phone number"). A dedicated fix agent fetches the event from the public `/api/fix-queue` endpoint, re-scrapes the source URL, and re-submits a corrected version with `fixedFromEventId`. The original reviewer gets a bell notification showing exactly what was asked for and what was changed.

**Learning loop:** On every scheduled run, the last 50 rejections for that source are injected into the agent's prompt, so extraction quality improves with each cycle.

---

## Key Features

### For Reviewers
- **Shared queue** — all pending events visible to the whole team, regardless of source; sortable by ingestion date or event date
- **Inline field editing** — correct any field before approving
- **Send for correction** — write a note, the AI fixes it and comes back; you get a bell notification with the correction details
- **Email alerts** — notified by email when new events arrive from any source
- **Personal dashboard** — total approved, rejected, sent for correction, and how many of your corrections were ultimately approved; today's counts vs. all-time
- **Queue by source** — see pending counts per source, click to filter

### For Admins
- **Event Sources** — add, configure, enable/disable sources; each has its own Claude agent and cron schedule
- **Run Now** — trigger any agent manually from the UI
- **AI Analytics** — approval rates by source, rejection reason breakdown, most-edited fields, events-over-time chart
- **Live activity feed** — real-time stream of every reviewer action (who approved/rejected what)
- **Reviewer leaderboard** — approvals per reviewer, average review time, today's count
- **User management** — invite reviewers (welcome email with pending event count), disable, enable, delete, change role
- **Data export** — CSV export of events, rejections, and field edits

### For AI Agents
- **Ingest endpoint** — `POST /api/ingest/:slug` accepts camelCase event payloads; no auth required (slug is the credential)
- **Fix queue endpoint** — `GET /api/fix-queue` (public, CORS-enabled) returns all events pending correction with reviewer notes
- **Automatic reviewer notifications** — every ingest triggers emails to all active users
- **Fix-back linking** — `fixedFromEventId` in the payload links the corrected event back to the original, triggers bell notification, and cleans up the fix queue

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| Database | MySQL 8 — DigitalOcean Managed Database |
| AI | Anthropic Claude — Sessions API (one agent per source) |
| Auth | Firebase Authentication (Google sign-in) |
| Email | Resend |
| Icons | Lucide React |
| Deployment | Vercel (serverless functions + edge) |
| CI | GitHub Actions |

---

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── admin/
│   │   │   ├── activity/          GET  — live feed, reviewer leaderboard, today's stats
│   │   │   ├── agent-analytics/   GET  — per-agent performance data
│   │   │   ├── stats/             GET  — approval rates, rejections, field edits, timeline, CSV export
│   │   │   └── test-email/        POST — send a test review notification email
│   │   ├── agent/
│   │   │   ├── runs/              GET  — agent run history
│   │   │   ├── runs/[id]/stop/    POST — stop a running agent
│   │   │   ├── schedule/          GET  — Vercel cron endpoint (triggers all active agents)
│   │   │   └── trigger/[id]/      POST — manual trigger from the UI
│   │   ├── auth/me/               GET  — current user from Firebase token
│   │   ├── cleanup/               POST — daily cron: purge past-date events
│   │   ├── events/
│   │   │   ├── [id]/              GET/PATCH — event detail; field edit
│   │   │   ├── [id]/edit/         POST — edit fields + log to field_edit_log
│   │   │   └── [id]/rejection/    GET  — rejection detail for an event
│   │   ├── fix-queue/             GET  — public: all events pending AI correction
│   │   ├── ingest/[slug]/         POST — agent ingest endpoint
│   │   ├── notifications/
│   │   │   ├── (root)/            GET  — list notifications for current user
│   │   │   ├── [id]/read/         POST — mark one notification read
│   │   │   └── review/            POST — mark all read
│   │   ├── review/
│   │   │   ├── events/[id]/       GET  — full event for review card
│   │   │   ├── events/[id]/action/       POST — approve or reject
│   │   │   ├── events/[id]/send-for-correction/ POST — queue for AI fix
│   │   │   └── queue/             GET  — paginated pending events
│   │   ├── reviewer/dashboard/    GET  — personal stats + queue breakdown
│   │   ├── setup/                 GET  — DB health check / initialization
│   │   ├── sources/               GET/POST — list sources; create source
│   │   ├── sources/[id]/          PATCH/DELETE — update or delete source
│   │   └── users/
│   │       ├── (root)/            GET  — list all users
│   │       ├── [id]/              PATCH/DELETE — update or delete user
│   │       ├── invite/            POST — create user + send welcome email
│   │       └── me/                GET  — current user profile
│   ├── admin/
│   │   ├── analytics/             AI analytics dashboard
│   │   ├── controls/              User management (invite, disable, delete, role)
│   │   ├── sources/               Source management (add, run, configure)
│   │   ├── stats/                 Overview dashboard + live activity
│   │   └── users/                 User list
│   ├── events/
│   │   ├── [id]/                  Event detail (public deep link)
│   │   ├── approved/              Approved events list
│   │   ├── pending/               Pending events list
│   │   └── rejected/              Rejected events list
│   ├── reviewer/
│   │   ├── dashboard/             Personal reviewer dashboard
│   │   ├── events/[id]/           Event review detail page
│   │   └── queue/                 Review queue
│   ├── login/                     Firebase Google sign-in
│   └── settings/                  User settings
├── components/
│   └── layout/Sidebar.tsx         Collapsible nav, bell notifications, role preview
├── hooks/
│   └── useAuth.ts                 Firebase token, user state, role guard
└── lib/
    ├── agentRunner.ts             Anthropic Sessions API long-poll execution + overrideUserMessage
    ├── auth.ts                    Server-side Firebase token verification + role check
    ├── db.ts                      MySQL2 pool (15 connections, queueLimit 30)
    ├── email.ts                   Resend: review notification, welcome email, agent summary
    ├── firebase-admin.ts          Firebase Admin SDK init
    ├── firebase.ts                Firebase client SDK init
    ├── rejectionHistory.ts        Builds rejection context block for agent prompts
    └── timezone.ts                Client-side date/time formatting
```

---

## Database Schema

### `sources`
Each row is one event calendar. One Claude agent per source.

| Column | Type | Notes |
|---|---|---|
| `slug` | VARCHAR(80) UNIQUE | Used in the ingest URL: `/api/ingest/:slug` |
| `agent_id` | VARCHAR(120) | Anthropic agent ID from the console |
| `schedule_cron` | VARCHAR(50) | e.g. `0 6 * * *` = daily at 6 AM |
| `calendar_source_name` | VARCHAR(120) | Embedded in every extracted event |
| `active` | TINYINT | 0 disables scheduling and run-now |

### `users`
Pre-registered accounts. A user cannot sign in until added here by an admin.

| Column | Type | Notes |
|---|---|---|
| `firebase_uid` | VARCHAR(128) UNIQUE | Populated on first sign-in |
| `role` | ENUM(`admin`,`reviewer`) | Enforced server-side on every request |
| `active` | TINYINT | Disabled users are rejected at auth |

### `raw_events`
Every event extracted by any agent. Moves through the review lifecycle.

| Column | Type | Notes |
|---|---|---|
| `status` | ENUM | `pending` → `approved` / `rejected` / `pending_fix` |
| `sessions` | JSON | `[{ startTime, endTime, ... }]` |
| `geo_scope` | ENUM | `local`, `hyper_local`, `city_wide`, `county`, `regional`, `national` |
| `sent_for_correction` | TINYINT | 1 when reviewer sent back for AI fix |
| `corrected_from_id` | INT | Links fixed event back to original |
| `calendar_source_url` | TEXT | Source page URL — used as fallback for fix matching |
| `sent_for_fix_by` | VARCHAR | Email of reviewer who sent for correction |

### `needs_fix`
Queue of events currently awaiting AI correction. `UNIQUE(raw_event_id)` prevents duplicate fix requests.

| Column | Notes |
|---|---|
| `raw_event_id` | FK to `raw_events` |
| `correction_notes` | Reviewer's note to the fix agent |
| `sent_by_user_id` | Who sent it — used to target the bell notification |

### `notifications`
In-app bell notifications. Current types:

| Type | Trigger |
|---|---|
| `event_fixed` | Fix agent submitted a corrected event |

Notification title: `"Fixed: {event title}"`. Message: `"You asked: {notes} · Fixed: {agent summary}"`.

### `review_sessions`
Every reviewer action with timing. Rejection history from this table is injected into agent prompts as a few-shot learning signal.

| Column | Notes |
|---|---|
| `action` | `approved`, `rejected`, `sent_for_correction` |
| `time_spent_sec` | Wall-clock time from open to submit |
| `submitted_to_ch` | 1 when successfully posted to CommunityHub |

### `agent_runs`
Full execution log per agent invocation.

| Column | Notes |
|---|---|
| `status` | `running` → `completed` / `failed` |
| `events_found` | Agent's own count claim |
| `events_extracted` | Actually inserted |
| `prompt_tokens` / `completion_tokens` | Token usage tracking |
| `error_log` | JSON array of error messages |

### `event_stats_archive`
Per-source counts snapshotted before the cleanup cron deletes past-date events, so historical stats survive expiry. Intentionally has no foreign keys, so archived rows outlive the sources they came from.

| Column | Notes |
|---|---|
| `source_id` / `source_name` | Denormalized source identity (kept even if the source is later deleted) |
| `total` / `approved` / `rejected` / `edited` | Counts for the events being expired |
| `snapshotted_at` | When the snapshot was taken |

### Indexes (performance)

Composite indexes for hot query paths are applied by [`migrations/0003_performance_indexes.sql`](migrations/0003_performance_indexes.sql):

```sql
raw_events(status, created_at)              -- queue sort + filter
raw_events(source_id, status, created_at)   -- source-filtered queue
raw_events(corrected_from_id, status)       -- corrections-approved join
raw_events(calendar_source_url(191))        -- fix agent fallback lookup
review_sessions(reviewer_id, action, created_at)  -- personal stats
agent_runs(source_id, started_at)           -- last-run-status lookup
notifications(user_id, read_at)             -- unread count
```

All `DATE(col) = CURDATE()` predicates are written as `col >= CURDATE()` range conditions to stay sargable (index-friendly).

---

## API Reference

### Public endpoints (no auth)

#### `GET /api/events`
List events with filtering.

Query params:
- `status` — `pending`, `approved`, `rejected`, `all` (default)
- `source_id`, `source_slug`
- `event_type` — `ot`, `an`, `jp`
- `geo_scope` — `hyper_local`, `city_wide`, `county`, `regional`
- `from`, `to` — ISO date range on `created_at`
- `q` — full-text search on title + description
- `order` — `asc` or `desc` (default `desc`)
- `limit` — max 100 (default 50)
- `page` — zero-indexed

#### `GET /api/fix-queue`
Returns all events currently awaiting AI correction. CORS-enabled.

```json
{
  "ok": true,
  "count": 1,
  "events": [
    {
      "raw_event_id": 281,
      "correction_notes": "There is no phone number",
      "sent_by_email": "reviewer@example.com",
      "title": "Cinema and Media Department Open House",
      "calendar_source_url": "https://...",
      "sessions": [{ "startTime": "...", "endTime": "..." }]
    }
  ]
}
```

---

### Ingest (Agent → Platform)

#### `POST /api/ingest/:slug`
No auth required. The slug identifies the source.

**Request body:**
```json
{
  "events": [
    {
      "title": "Concert in the Park",
      "description": "Short description (max 200 chars)",
      "extendedDescription": "Full details...",
      "eventType": "ot",
      "sessions": [
        { "startTime": "2026-06-01T19:00:00", "endTime": "2026-06-01T21:00:00" }
      ],
      "locationType": "ph2",
      "placeName": "Tappan Square",
      "location": "Oberlin, OH 44074",
      "geoScope": "hyper_local",
      "calendarSourceName": "Oberlin Public Library",
      "calendarSourceUrl": "https://example.com/events/123",
      "contactEmail": "info@example.com",
      "phone": "440-775-8000",
      "website": "https://example.com",
      "fixedFromEventId": "281",
      "fixSummary": "Added phone number 440-775-8000 found on the source page."
    }
  ],
  "count": 1
}
```

`fixedFromEventId` — include when submitting a corrected event. Must match the `raw_event_id` from the fix-queue response. Triggers bell notification to the reviewer and removes the entry from the fix queue.

`fixSummary` — one sentence describing what was changed. Appears in the reviewer's bell notification.

**Response:**
```json
{ "ok": true, "run_id": 42, "source": "Oberlin Public Library", "inserted": 1, "pending_review": 1 }
```

On success, all active users receive an email: `"N new events from {source} · M total pending review"`.

---

### Authenticated endpoints (Firebase Bearer token)

All requests require `Authorization: Bearer <firebase-id-token>`.

#### Review

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/review/queue` | Paginated pending events (shared — all reviewers see all) |
| `GET` | `/api/review/events/:id` | Full event detail for the review card |
| `POST` | `/api/review/events/:id/action` | Approve or reject |
| `POST` | `/api/review/events/:id/send-for-correction` | Queue for AI fix with notes |
| `GET` | `/api/reviewer/dashboard` | Personal stats + global queue breakdown |

**Action body:**
```json
{
  "action": "approved",
  "reason_codes": [],
  "reviewer_note": "",
  "edits": { "phone": "440-775-8000", "title": "Updated Title" }
}
```

**Send-for-correction body:**
```json
{ "correction_notes": "Missing phone number and contact email." }
```

#### Admin

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/admin/stats?type=stats&days=30` | Summary totals |
| `GET` | `/api/admin/stats?type=by-source` | Approval rates per source |
| `GET` | `/api/admin/stats?type=rejection-reasons` | Rejection reason breakdown |
| `GET` | `/api/admin/stats?type=field-edits` | Most-edited fields |
| `GET` | `/api/admin/stats?type=timeline` | Events over time chart data |
| `GET` | `/api/admin/stats?type=export&format=csv` | CSV export |
| `GET` | `/api/admin/activity` | Live feed, reviewer leaderboard, today's counts |
| `POST` | `/api/agent/trigger/:source_id` | Manually trigger an agent run |
| `GET` | `/api/agent/runs` | Agent run history |

#### Users

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/users` | List all users with source assignments |
| `POST` | `/api/users/invite` | Create user + send welcome email with pending count |
| `PATCH` | `/api/users/:id` | Update name, role, active, source assignments |
| `DELETE` | `/api/users/:id` | Delete user + their source assignments + notifications |

#### Sources

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/sources` | All sources with last-run status and fix stats |
| `POST` | `/api/sources` | Create a new source |
| `PATCH` | `/api/sources/:id` | Update a source |
| `DELETE` | `/api/sources/:id` | Delete a source |

#### Notifications

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/notifications` | List notifications for current user + unread count |
| `POST` | `/api/notifications/:id/read` | Mark one notification read |

---

## Environment Variables

```env
# Database
DATABASE_HOST=db-mysql-xxx.b.db.ondigitalocean.com
DATABASE_PORT=25060
DATABASE_USERNAME=your_user
DATABASE_PASSWORD=your_password
DATABASE_NAME=your_database

# Firebase (client)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase (server)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}   # stringified JSON

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
SOURCE_BUILDER_ENVIRONMENT_ID=env_...

# Email
RESEND_API_KEY=re_...

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
CRON_SECRET=your_cron_secret
ADMIN_EMAIL=admin@yourorg.com        # receives agent run summaries (optional)
```

---

## Getting Started

### Prerequisites
- Node.js 20+
- MySQL 8 (local or [DigitalOcean Managed MySQL](https://www.digitalocean.com/products/managed-databases-mysql))
- Firebase project with Google sign-in enabled
- Anthropic API key + Sessions API access
- Resend account

### 1. Clone & install

```bash
git clone https://github.com/2024frank/ai-microgrant.git
cd ai-microgrant
npm install
```

### 2. Configure environment

Create `.env` in the project root with all values from the [Environment Variables](#environment-variables) section.

### 3. Initialize the database

The schema is managed by ordered migrations in [`migrations/`](migrations/), applied by a small runner that records what it has run. The same command initializes a fresh database and upgrades an existing one — each migration is idempotent and runs exactly once.

```bash
npm run db:migrate      # create/upgrade all tables
npm run db:seed         # seed the initial admin users
```

Useful companions:

```bash
npm run db:migrate:status   # show applied vs pending migrations
npm run db:dump-schema      # capture the live DB's real DDL → schema.snapshot.sql
```

> Adopting an existing database (e.g. a deployment created before migrations existed)? Just run `npm run db:migrate` — `0001_baseline` is `CREATE TABLE IF NOT EXISTS` so it skips tables you already have, and `0002_reconcile` brings any drifted ENUM columns up to date without touching your data.

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with your admin Google account.

### 5. Add your first source

1. Go to **Admin → Event Sources → Add source**
2. In the [Anthropic Console](https://console.anthropic.com), create a managed agent configured to:
   - Scrape your target calendar URL
   - Structure events using the [ingest payload schema](#post-apiingestslug)
   - POST to `https://your-app.vercel.app/api/ingest/your-source-slug`
3. Paste the agent ID and set a cron schedule
4. Click **Run Now** to trigger the first extraction

### 6. Invite reviewers

Go to **Admin → Admin Controls → Invite user**. Reviewers receive a welcome email with the current queue count and sign in with Google immediately.

---

## Deployment

### Vercel

```bash
npx vercel --prod
```

Set all environment variables in **Vercel Dashboard → Settings → Environment Variables**.

### Cron scheduling

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/agent/schedule",
      "schedule": "0 6 * * *"
    },
    {
      "path": "/api/cleanup",
      "schedule": "0 3 * * *"
    }
  ]
}
```

Secure the cron endpoint with `CRON_SECRET` — the route checks `Authorization: Bearer {CRON_SECRET}`.

---

## Contributing

Contributions welcome. This is intentionally unopinionated about which community or calendar sources you use — everything configurable lives in the database.

```bash
git checkout -b feature/your-feature
npm run dev       # develop
npm test          # run tests (Jest)
npm run lint      # ESLint
```

**Conventions:**
- All DB queries use parameterized queries via `mysql2` — no string interpolation
- Date predicates use range form (`col >= CURDATE()`) not function form (`DATE(col) = CURDATE()`)
- New multi-column WHERE/ORDER patterns should have a composite index
- API routes use `getAuthUser(req)` from `src/lib/auth.ts` for server-side role enforcement
- The fix agent always receives `fixedFromEventId` in the user message — never rely on the agent to pick the right ID from the fix-queue response alone

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*Built with [Anthropic Claude](https://anthropic.com) · [Next.js](https://nextjs.org) · [Firebase](https://firebase.google.com) · [Resend](https://resend.com) · [MySQL](https://mysql.com) · Deployed on [Vercel](https://vercel.com)*
