# Long-description optionality — verification status (meeting item 7)

## What is confirmed

1. CommunityHub's own payload documentation lists `extendedDescription` under
   *Optional Fields* (see `docs/communityhub-api.md`).
2. The live Oberlin feed (read-only check, 2026-07-17) serves an approved post
   ("Music Open Mic") whose `extendedDescription` is an empty string. The
   platform therefore stores, approves, and serves posts without a long
   description.
3. This application never requires the field: `validateCommunityHubPayload`
   omits `extendedDescription` from the outbound payload when it is empty, and
   both the public event view and the newsletter templates render no
   "Long description" heading when the field is absent.

## What is NOT yet confirmed

A clean create-probe against `POST /post/submit` without `extendedDescription`
has not been run from this codebase. The 2026-07-16 meeting attempt was
inconclusive because the response was an unrelated image error ("failed to
download image from URL") — that error class is now detected before submission
and classified separately (`image_download_failed` /
`communityhub_image_download`), so the next real submission of an event
without a long description settles the question with a clean signal.

Per the meeting agreement: do not claim CommunityHub REQUIRES the field until
a submission actually fails with a long-description validation error.

## If CommunityHub rejects a missing long description

Record the exact API response in `communityhub_submissions.error_message`
(this happens automatically), then send the message below to Peter, copying
John. Draft — review before sending:

> Subject: Optional long descriptions on calendar submissions
>
> Hi Peter,
>
> While integrating the event intake application with the calendar's
> POST /api/legacy/calendar/post/submit endpoint, we found that submissions
> without an extendedDescription value are rejected. The exact response was:
>
> [paste the recorded API response here]
>
> Your payload documentation lists extendedDescription as optional, and some
> existing posts on the calendar have no long description, so we believe the
> create endpoint's validation may be stricter than intended. Many short
> community events have no additional detail beyond their short description,
> and inventing filler text to satisfy the field is something we want to
> avoid.
>
> Could the endpoint accept an omitted or empty extendedDescription? Happy to
> test a change from our side.
>
> Thanks,
> Frank
>
> Cc: John
