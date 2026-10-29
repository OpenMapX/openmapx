---
impacts: [breaking]
---

## What changes

Live Dawarich and retained-backup privacy source archives now require canonical
USTAR regular-file headers. GNU/PAX extensions, unsupported format markers and
malformed numeric fields are rejected. Member sizes, manifest sizes and total
budgets include the final manifests before the backup collector starts output.

## Who is affected

This affects the internal archives supplied to privacy export collectors. It does
not change the subject's delivered export format. The managed Ruby and Python
producers are verified against the shared reader, including the pinned Dawarich
image and the networkless retained-backup fixture.

## Required action

No database migration or manual action is required for managed producers. Use the
collector supplied by the release. A source archive rejected for noncanonical
framing must be regenerated through that collector; there is no permissive parser
fallback.
