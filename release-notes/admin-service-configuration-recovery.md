---
impacts: [operator-action]
---

## What changes

Failed service configuration activation can restore saved overrides only while
that request still owns the exact database row version. Later edits are retained.
A failed or uncertain activation remains an error and does not promise restoration
or successful host activation.

Data operations now queue validated raw form input and normalize it again at
execution. Full Update Pipeline requests with country filters can reach the typed
update operation; previews and audit details remain normalized.

## Who is affected

Administrators changing service configuration or running data operations,
especially Full Update Pipeline jobs with a nonempty countries filter.

## Required action

After a failed configuration change, inspect the saved settings and applied host
state before deciding how to reconcile them. A newer saved edit may have prevented
restoration; an unknown host outcome is not evidence that activation failed.

Previously queued jobs containing normalized countries arrays remain invalid.
Inspect their outcome before explicitly submitting a new intended operation if
needed. This correction does not convert queued jobs, retry them automatically,
or require a database migration or cache reset.
