---
impacts: [migration]
---

## What changes

Privacy request emails are sent each time their event recurs: a requester
is emailed whenever a case waits on them again and for every deadline
extension, and administrators get a new deadline reminder after an
extension. Previously only the first of each was sent. Migration
`0064_privacy_notification_occurrence_key` adds an `occurrence_key` column to
`data_subject_request_notification` and adds it to that table's unique index.

## Who is affected

Every installation applies the migration at API startup. Requests that
are already due soon and were already reminded get one more reminder per
administrator after the update.

## Required action

None. The column has a default, so existing rows need no conversion.
