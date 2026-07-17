# CommunityHub legacy calendar API — reference

Source: CommunityHub team documentation (shared 2026-07-16 meeting follow-up).
This is the external contract this application publishes against. The payload
builder in `src/lib/communityHubPayload.ts` and the inventory reader in
`src/lib/communityHubInventory.ts` must stay consistent with this document.

## Endpoints

| Operation | Endpoint |
| --- | --- |
| Create post | `POST https://oberlin.communityhub.cloud/api/legacy/calendar/post/submit` |
| Replace post | `POST https://oberlin.communityhub.cloud/api/legacy/calendar/post/{id}/submit` |
| Partial update | `PATCH https://oberlin.communityhub.cloud/api/legacy/calendar/post/{id}/submit` (send only the fields to change) |
| Read post | `GET https://oberlin.communityhub.cloud/api/legacy/calendar/post/{id}` |
| List posts | `GET https://oberlin.communityhub.cloud/api/legacy/calendar/posts` |

### List parameters (`/posts`)

| Parameter | Example | Meaning |
| --- | --- | --- |
| `limit` | `10000` | Max posts per response |
| `page` | `0` | Zero-indexed page |
| `filter` | `future` | Only future and ongoing posts |
| `tab` | `main-feed` | Main public feed |
| `isJobs` | `false` | Exclude job posts |
| `order` | `ASC` | Sort by date ascending |
| `postType` | `All` | Events and announcements |
| `allPosts` | (present, empty) | Include approved AND unapproved posts |

## CommunityHub database model (prod_calendar)

The calendar is multi-community (Oberlin, Cleveland, ...). Relevant tables:

- `post` — every event/announcement/job. Key columns: `name` (title),
  `description` (short), `extended_description` (long, shown on detail page),
  `approved` (`1` approved, `0` rejected, `NULL` pending), `is_announcement`,
  `event_type` (`ot`/`an`/`jp`), `location_type`, `calendar_source_name`,
  `calendar_source_url`, `timezone` (default `America/New_York`),
  `community_id`, `image`/`gallery_image`/`original_image`/`crop_config`.
- `session` — one row per occurrence (`start`, `end`, `post_id`). A post can
  have many sessions.
- `post_type` — per-community categories (`name`, `type` = ot/jp/an, `position`).
- `post_type_transactions` — join table: which categories a post belongs to.
  This is what `postTypeId` in the submit payload populates, and what the
  calendar displays as the post's categories.
- `sponsor` + `post_sponsor` — sponsors credited on a post (many-to-many).
- `organization` + `post_organization` — associated organizations.
- `screen` + `post_screen` — digital signage screens.
- `location` — reusable venues (`name`, `address`, `lat`/`lon`,
  `google_place_id`).
- `rejection` — admin rejection reasons per post (a post can be rejected more
  than once).
- `post_approval_track` — audit trail of approve/reject actions.
- `post_button` — call-to-action buttons (`title`, `link`).
- `newsletter`, `newsletter_recipient`, `post_type_newsletter_recipient`,
  `spam_reporting` — newsletter delivery.
- `user` — Auth0-backed admin/user profiles.

## Submit payload

Required for all post types:

| Field | Type | Constraints |
| --- | --- | --- |
| `eventType` | string | `"ot"`, `"an"`, or `"jp"` |
| `email` | string | valid email |
| `title` | string | 1-60 characters |
| `description` | string | 10-200 characters |
| `sponsors` | string[] | min 1 |
| `postTypeId` | number[] | min 1 (see category IDs below) |
| `sessions` | `{startTime,endTime}[]` | Unix seconds |
| `display` | string | `all`, `ps`, `sps`, `ss` |

Conditional:

| Field | Condition |
| --- | --- |
| `location` | required when `locationType` is `ph2` or `bo` |
| `urlLink` | required when `locationType` is `on` or `bo` |
| `screensIds` | min 1 when `display` is `ss` |

Optional (per CommunityHub's own documentation): `phone`, `website`,
`contactEmail`, **`extendedDescription` (max 1000 chars — the long description
is NOT required)**, `buttons`, `roomNum`, `calendarSourceUrl`,
`calendarSourceName`, `ingestedPostUrl`, `image_cdn_url` (a URL CommunityHub
downloads the image from), `placeId`, `placeName`, `subscribe`, `public`.

Announcements use `locationType: "ne"` and equal `startTime`/`endTime` when
there is no duration; the session window is the announcement's display window.

Observed live 2026-07-16 (not in CommunityHub's docs): `POST /post/submit`
answers `500 "Session Start Date & End Date can not be same"` for an EVENT
whose session end equals its start (the "Summer Symphony" submission). The
payload validator therefore rejects equal start/end for non-announcement
types before submission; when a source states no end time, a reviewer must
supply one. Whether the same rule applies to announcements contradicts their
documented sample and has not been observed; the error classifier records
the evidence if it ever happens.

### Long-description optionality evidence (requirement 7)

- CommunityHub's payload documentation lists `extendedDescription` under
  *Optional Fields*.
- The live Oberlin feed (checked 2026-07-17, read-only) contains an approved
  post ("Music Open Mic") whose `extendedDescription` is an empty string, so
  the platform stores and serves posts without a long description.
- A live create-probe without `extendedDescription` has not been run from this
  codebase yet; the 2026-07-16 meeting attempt was inconclusive because the
  response was an unrelated image error ("failed to download image from URL").
  Until a clean probe succeeds, do not claim CommunityHub REQUIRES the field —
  the documented contract says it is optional.

### Category (post type) IDs — Oberlin

| ID | Name |
| --- | --- |
| 1 | Volunteer Opportunity |
| 2 | Exhibit |
| 3 | Fair, Festival, or Public Celebration |
| 4 | Tour, Walking Tours or Open House |
| 5 | Film |
| 6 | Presentation or Lecture |
| 7 | Workshop or Class |
| 8 | Music Performance |
| 9 | Theatre or Dance |
| 10 | City Government |
| 11 | Spectator Sport |
| 12 | Participatory Sport or Game |
| 13 | Networking Event |
| 59 | Ecolympics or Environmental |
| 89 | Other |

Category IDs are per-community (`post_type.community_id`); these IDs are the
Oberlin set and must not be reused for another community.
