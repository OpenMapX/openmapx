---
impacts: [breaking]
---

## What changes

The provider health API moved from `/api/data-manager/providers` to the
administration namespace: `GET /api/admin/providers`,
`GET /api/admin/providers/:id` and `POST /api/admin/providers/:id/reset`. The old
paths are gone and answer 404. Responses are unchanged.

The data-manager service token no longer reads provider health. All three routes
now require an administrator session, as the reset route already did. Nothing in
OpenMapX used the token for these reads; data-manager never called them.

The admin **Transit → Provider health** table uses the new paths and looks the
same. Each reset is now recorded in the activity log as "Provider health reset".

## Who is affected

Only operators whose own scripts or monitoring read provider health from
`/api/data-manager/providers` or `/api/data-manager/providers/:id`, with an
administrator session or the data-manager service token. The web app,
data-manager and the CLI need no change.

## Required action

Point such scripts at `/api/admin/providers` and authenticate them with an
administrator session. A script that relied on the data-manager service token
has no replacement token: read the admin view instead, or keep an administrator
session for the script. No action is needed if you only use the admin pages.
