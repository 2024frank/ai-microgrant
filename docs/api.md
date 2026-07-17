# AI Events Aggregator — API Documentation

**Base URL:** `https://ai-microgrant-research-oberlin.vercel.app`

---

## Authentication

Most API routes require a **Firebase ID token** passed as a Bearer token:

```
Authorization: Bearer <firebase_id_token>
```

Tokens are obtained by signing in with Google via Firebase Authentication.

**Roles:**
- `admin` — full access to all endpoints
- `reviewer` — access to review queue and own dashboard only

**Public endpoints (no token required):**
- `GET /api/events` — fetch all events
- `GET /api/events/:id` — fetch a single event

---

## Public Events API

### `GET /api/events`

Fetch events from the system. **No authentication required.** CORS enabled — can be called from any domain.

#### Query Parameters

| Parameter    | Type   | Default  | Description |
|-------------|--------|----------|-------------|
| `status`    | string | `all`    | Filter by review status: `pending` \| `approved` \| `rejected` \| `resubmitted` \| `submitted` \| `publishing` \| `superseded` \| `pending_fix` \| `duplicate` \| `all` (non-approved statuses require auth) |
| `source_id` | number | —        | Filter by source organisation ID |
| `source_slug` | string | —      | Filter by source slug (e.g. `oberlin-college`) |
| `event_type` | string | —       | Filter by type: `ot` (event) \| `an` (announcement) \| `jp` (job) |
| `geo_scope` | string | —        | Filter by scope: `hyper_local` \| `city_wide` \| `county` \| `regional` |
| `from`      | string | —        | ISO 8601 date — events created on or after (e.g. `2026-05-01`) |
| `to`        | string | —        | ISO 8601 date — events created on or before (e.g. `2026-05-31`) |
| `q`         | string | —        | Full-text search across title and description |
| `page`      | number | `0`      | Zero-indexed page number |
| `limit`     | number | `50`     | Results per page (max: 100) |
| `order`     | string | `desc`   | Sort by created_at: `asc` \| `desc` |

#### Example Requests

```bash
# All approved events
GET /api/events?status=approved

# All rejected events
GET /api/events?status=rejected

# Everything — all statuses
GET /api/events?status=all&limit=100

# Approved events from a specific source
GET /api/events?status=approved&source_id=1

# Search approved events
GET /api/events?status=approved&q=jazz&limit=20

# Approved events in a date range
GET /api/events?status=approved&from=2026-05-01&to=2026-05-31

# City-wide approved events, oldest first
GET /api/events?status=approved&geo_scope=city_wide&order=asc

# Paginate
GET /api/events?status=approved&page=0&limit=25
GET /api/events?status=approved&page=1&limit=25
```

#### Response

```json
{
  "events": [ Event ],
  "pagination": {
    "total":    150,
    "page":     0,
    "limit":    50,
    "pages":    3,
    "has_next": true,
    "has_prev": false
  },
  "filters": {
    "status":      "approved",
    "source_id":   null,
    "source_slug": null,
    "event_type":  null,
    "geo_scope":   null,
    "from":        null,
    "to":          null,
    "q":           null,
    "order":       "DESC"
  }
}
```

#### Event Object

```json
{
  "id":                   1,
  "event_type":           "ot",
  "title":                "Jazz Night at Apollo Theatre",
  "description":          "An evening of live jazz featuring local Oberlin musicians.",
  "extended_description": "Full program includes...",
  "sponsors":             ["Apollo Theatre"],
  "post_type_ids":        [8],
  "sessions": [
    {
      "startTime": 1714492800,
      "endTime":   1714500000
    }
  ],
  "location_type":        "ph2",
  "location":             "19 E College St, Oberlin, OH 44074",
  "place_name":           "Apollo Theatre",
  "room_num":             null,
  "url_link":             null,
  "display":              "all",
  "buttons": [
    { "title": "Get Tickets", "link": "https://apollotheatre.org/tickets" }
  ],
  "contact_email":        "info@apollotheatre.org",
  "phone":                null,
  "website":              "https://apollotheatre.org",
  "image_cdn_url":        "https://example.com/jazz.jpg",
  "calendar_source_name": "Apollo Theatre",
  "calendar_source_url":  "https://apollotheatre.org/events",
  "ingested_post_url":    "https://ai-microgrant-research-oberlin.vercel.app/events/1",
  "geo_scope":            "city_wide",
  "status":               "approved",
  "communityhub_post_id": "abc123",
  "source_id":            1,
  "source_name":          "Apollo Theatre",
  "source_slug":          "apollo-theatre",
  "created_at":           "2026-05-18T14:30:00.000Z",
  "updated_at":           "2026-05-18T15:00:00.000Z"
}
```

#### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique event ID |
| `event_type` | string | `ot` = event, `an` = announcement, `jp` = job |
| `title` | string | Event title (max 60 chars) |
| `description` | string | Short description (max 200 chars) |
| `extended_description` | string \| null | Long description (max 1000 chars) |
| `sponsors` | string[] | Organising organisations |
| `post_type_ids` | number[] | Category IDs (see Post Types) |
| `sessions` | Session[] | Array of `{startTime, endTime}` — **Unix timestamps in seconds** |
| `location_type` | string | `ph2` in-person, `on` online, `bo` hybrid, `ne` none |
| `location` | string \| null | Street address |
| `place_name` | string \| null | Venue name |
| `room_num` | string \| null | Room identifier |
| `url_link` | string \| null | Stream or online event URL |
| `display` | string | `all`, `ps`, `sps`, or `ss` |
| `buttons` | Button[] | `{title, link}` — registration or info links |
| `contact_email` | string \| null | Contact email |
| `phone` | string \| null | Contact phone |
| `website` | string \| null | Event website |
| `image_cdn_url` | string \| null | Event image URL |
| `calendar_source_name` | string | Source organisation name |
| `calendar_source_url` | string \| null | Original source listing URL |
| `ingested_post_url` | string | Deep link to this event in the aggregator |
| `geo_scope` | string \| null | Geographic scope of the event |
| `status` | string | `pending`, `approved`, `rejected`, `resubmitted` |
| `communityhub_post_id` | string \| null | CommunityHub post ID (set after approval) |
| `source_id` | number | Source organisation ID |
| `source_name` | string | Source organisation name |
| `source_slug` | string | Source organisation URL-safe identifier |
| `created_at` | string | ISO 8601 UTC datetime |
| `updated_at` | string | ISO 8601 UTC datetime |

#### Working with Sessions (Unix Timestamps)

Sessions contain Unix timestamps in **seconds** (not milliseconds).

```javascript
// Convert to local time (browser/Node.js)
const session = event.sessions[0];
const start = new Date(session.startTime * 1000);
const end   = new Date(session.endTime   * 1000);

// Display in user's local timezone
start.toLocaleString();
// → "May 18, 2026, 7:00 PM" (respects browser timezone)

// Display date only
start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
// → "Sunday, May 18, 2026"

// Display time only
start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// → "7:00 PM"

// Get timezone abbreviation
start.toLocaleTimeString([], { timeZoneName: 'short' }).split(' ').pop();
// → "EDT"

// Convert to ISO string (UTC)
start.toISOString();
// → "2026-05-18T23:00:00.000Z"
```

#### Post Type IDs

| ID | Name |
|----|------|
| 1  | Volunteer Opportunity |
| 2  | Exhibit |
| 3  | Fair, Festival, or Public Celebration |
| 4  | Tour, Walking Tours or Open House |
| 5  | Film |
| 6  | Presentation or Lecture |
| 7  | Workshop or Class |
| 8  | Music Performance |
| 9  | Theatre or Dance |
| 10 | City Government |
| 11 | Spectator Sport |
| 12 | Participatory Sport or Game |
| 13 | Networking Event |
| 59 | Ecolympics or Environmental |
| 89 | Other |

---

### `GET /api/events/:id`

Fetch a single event by ID. **No authentication required.**

Used by the `ingestedPostUrl` deep link — when CommunityHub editors click the link on a published event, they land on `/events/:id`.

```bash
GET /api/events/1
```

Returns a single Event object (same shape as above).

**Error response (404):**
```json
{ "error": "Not found" }
```

---

## Authenticated Endpoints

All endpoints below require `Authorization: Bearer <token>`.

---

### Sources

#### `GET /api/sources`
List all source organisations. Requires auth (any role).

#### `POST /api/sources`
Add a new source. Requires `admin`.

```json
{
  "name":          "Apollo Theatre",
  "agent_id":      "agt_abc123",
  "schedule_cron": "0 6 * * *"
}
```

- `name` — display name of the organisation
- `agent_id` — unique Claude agent ID from Anthropic console
- `schedule_cron` — cron schedule (default: `0 6 * * *` = daily at 6am)

On creation, the first fetch fires immediately in the background.

#### `PATCH /api/sources/:id`
Update a source. Requires `admin`. Accepts: `name`, `agent_id`, `schedule_cron`, `active`,
plus stable organization metadata stamped onto every ingested event
(`org_sponsor_name`, `org_website`, `org_phone`, `org_contact_email`) and the
source classification `source_kind` (`original_org` | `aggregator`). Aggregators
(e.g. Localist) dispatch after original-organization sources and their candidates
defer to events already obtained from a more direct source.

#### `DELETE /api/sources/:id`
Soft-deactivate a source (sets `active = 0`). Requires `admin`.

---

### Agent Runs

#### `POST /api/agent/trigger/:source_id`
Manually trigger an agent run for a source. Requires `admin`.

#### `GET /api/agent/runs`
Get recent agent run history with live status. Requires `admin`.

Query params: `source_id`, `limit` (default 10).

Response includes `has_active: boolean` — poll every 2s while `true` for live updates.

#### `GET /api/agent/schedule`
Cron endpoint — triggered by Vercel Cron daily at 6am. Secured with `CRON_SECRET`.
Dispatches original-organization sources before aggregators and then invokes
`/api/agent/system-corrections`.

#### `POST /api/agent/queue-conformance`
Cron/`CRON_SECRET` endpoint, also run on every scheduler tick. Brings pending
review-queue events up to the agreed format: applies the deterministic
corrections in place (marker sentences, URL/address stripping, registration
button, exact Apollo titles; every change audited in `field_edit_log` with a
NULL reviewer), repairs posters (remote images materialized to stored bytes,
permanently dead images removed, transient failures flagged), and rejects
events that still miss required fields or whose opportunity-announcement
titles state no action (`format_nonconforming`) so the correction agent can
fix them; everything else stays queued for human approval.

#### `POST /api/agent/system-corrections`
Cron/`CRON_SECRET` endpoint. Requeues events the platform auto-rejected as
"Required fields are missing" (rejection origin `system`) through the existing
correction workflow — one bounded attempt per event, never creating duplicates
(corrections must reference the original via `fixedFromEventId`).

#### `GET /api/inventory/intake?token=…`
Read-only, gated by a read token derived from `CRON_SECRET` (HMAC, no new
secret to provision; `CRON_SECRET` bearer auth also works). The intake queue
as comparison content for duplicate checking: active drafts (`pending`,
`submitted`, `approved`, `publishing`, `resubmitted`, `pending_fix`) with
title, event type, both descriptions, source page URL, normalized sessions,
status, and source name. Extraction agents receive the tokened URL inside
their private instructions at contract-sync time, fetch this together with
the CommunityHub inventory, and drop events whose entire content already
appears in either place. Carries no record IDs (IDs never participate in
duplicate matching) and no contact or reviewer data — drafts here are
unreviewed, which is why the endpoint is not anonymous.

---

### Review

#### `GET /api/review/queue`
Get pending events for review. Reviewers see only their assigned sources.

Query params: `page`, `limit`, `source_id`.

#### `GET /api/review/events/:id`
Get full event detail for the review card.

#### `POST /api/review/events/:id/action`
Approve or reject an event.

```json
{
  "action": "approve",
  "edits": {
    "title": "Updated title",
    "description": "Updated description"
  },
  "time_spent_sec": 45
}
```

```json
{
  "action": "reject",
  "edits": {
    "reason_codes": ["wrong_audience", "bad_date_parse"],
    "reviewer_note": "This is an internal faculty event"
  },
  "time_spent_sec": 20
}
```

**Rejection reason codes:**

| Code | Meaning |
|------|---------|
| `wrong_audience` | Restricted to staff/students/faculty only |
| `bad_date_parse` | Date or time extracted incorrectly |
| `duplicate_missed` | Already exists in CommunityHub |
| `description_hallucinated` | Agent added details not in source |
| `missing_fields` | Required fields were left empty |
| `wrong_geo_scope` | Geographic scope tagged incorrectly |
| `not_public_event` | Private or invitation-only event |
| `wrong_post_type` | Category tagged incorrectly |
| `bad_location` | Location missing or wrong |
| `other` | See reviewer_note |

All rejections are stored and fed back to the agent as few-shot learning examples on its next run.

---

### Event Editing

#### `POST /api/events/:id/edit`
Save field edits to an event without approving it. Every edit is logged to `field_edit_log` as agent teaching data.

```json
{
  "edits": {
    "title": "Corrected title",
    "sessions": [{ "startTime": 1714492800, "endTime": 1714500000 }]
  },
  "note": "Agent extracted wrong date from the source"
}
```

Response includes `changed_fields` (array of field names that actually changed) and `agent_id` (the agent that will learn from this).

---

### Admin Analytics

#### `GET /api/admin/stats`

Query params:
- `type`: `stats` \| `by-source` \| `rejection-reasons` \| `field-edits` \| `timeline` \| `export`
- `days`: `7` \| `30` \| `90` (default: `30`)
- `source_id`: filter to one source
- `format`: `json` \| `csv` (for export type)
- `export_type`: `events` \| `rejections` \| `field-edits` (for export type)

#### `GET /api/admin/activity`
Recent reviewer actions, per-reviewer stats, recent agent runs, today's counts.

Query params: `limit` (default 20).

#### `GET /api/admin/comparisons`
Two-way integration-vs-calendar comparisons recorded per agent run. Requires
`admin`. Without params: recent runs with counts (`matched_both`,
`integration_only`, `calendar_only`, `duplicates_preserved`). With `?run_id=`:
the full report — every candidate with its outcome and preserved duplicate
evidence (field-level differences vs the matched CommunityHub post, including
direct human submissions), plus calendar posts attributed to the organization
that the integration missed.

---

### Users

#### `GET /api/users`
List all users. Requires `admin`.

#### `POST /api/users/invite`
Add a new user. Sends a welcome email. Requires `admin`.

```json
{
  "email":      "jane@oberlin.edu",
  "full_name":  "Jane Smith",
  "role":       "reviewer",
  "source_ids": [1, 2]
}
```

`source_ids` is optional — leave empty to assign all sources.

#### `PATCH /api/users/:id`
Update a user's name, role, active status, or source assignments. Requires `admin`.

---

### Notifications

#### `POST /api/notifications/review`
Manually trigger review notification emails to all active reviewers. Requires `admin`.

---

### Reviewer Dashboard

#### `GET /api/reviewer/dashboard`
Returns personalised dashboard data: pending count, personal stats, recent activity, assigned sources, oldest pending event.

---

### Auth

#### `GET /api/auth/me`
Returns the authenticated user's profile. Used on login to determine role and redirect.

---

### Setup

#### `GET /api/setup?secret=<SETUP_SECRET>`
One-time route to seed initial admin users. Protected by `SETUP_SECRET` env var. Remove after use.

---

## Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing or invalid fields |
| `401` | Unauthorized — missing or invalid token |
| `403` | Forbidden — insufficient role |
| `404` | Not found |
| `409` | Conflict — duplicate (e.g. agent_id already assigned) |
| `500` | Server error — check Vercel function logs |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_FIREBASE_*` | Yes | Firebase client config |
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Firebase admin SDK JSON |
| `DATABASE_HOST` | Yes | DigitalOcean MySQL host |
| `DATABASE_PORT` | Yes | MySQL port (25060) |
| `DATABASE_USERNAME` | Yes | MySQL username |
| `DATABASE_PASSWORD` | Yes | MySQL password |
| `DATABASE_NAME` | Yes | Database name (oberlin-calendar) |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for agents |
| `SOURCE_BUILDER_ENVIRONMENT_ID` | Yes | Shared Claude environment ID |
| `SOURCE_BUILDER_VAULT_ID` | Yes | Shared Claude vault ID |
| `AGENT_JSON_REPAIR_ATTEMPTS` | Optional | Same-session JSON repair attempts; defaults to 1 and is hard-capped at 2 |
| `RESEND_API_KEY` | Yes | Resend email API key |
| `CRON_SECRET` | Yes | Secret for Vercel cron job |
| `NEXT_PUBLIC_APP_URL` | Yes | Full app URL (e.g. https://ai-microgrant-research-oberlin.vercel.app) |
| `ADMIN_EMAIL` | Optional | Admin email for agent run summaries |
| `SETUP_SECRET` | Once | Remove after seeding admin users |
