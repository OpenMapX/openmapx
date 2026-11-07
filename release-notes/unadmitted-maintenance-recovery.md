---
impacts: [operator-action]
---

## What changes

Authenticated cancellation can close an expired application update whose Data
Manager adopted preparation but never admitted it. The original receiver proves
no work occurred under its database and lease-journal locks. The agent verifies
the unchanged candidate and original ownership closure before releasing it.
The API keeps the original failed receipt and finishes the job as failed.

## Who is affected

Installations with an update stuck at preparation after the older Data Manager
refused built-in service targets. Admitted or uncertain work remains pending.

## Required action

Install the corrected API, ops-agent and Data Manager together before canceling
the original job with a full administrator session. A blocked installation may
need a separately supervised installation first. After verified recovery, start
a fresh checked update. Recovery creates no backup and never resumes the expired
attempt. Preserve original records and avoid downgrading control images that
cannot read the new evidence; see the upgrading guide.
