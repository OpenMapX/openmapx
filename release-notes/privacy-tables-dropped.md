---
impacts: [migration]
---

## What changes

Migration `0057_drop_privacy_gate_snapshots_backup_reviews` drops the
`data_subject_request_approval`, `data_subject_request_source_snapshot` and
`data_subject_request_backup_review` tables. Their rows are not converted.

## Who is affected

Every installation that applies the migration. Release approvals, receipt
snapshots and backup review records it held are deleted.

## Required action

None beyond the normal update; the migration runs before the API starts.
Restoring a backup taken before this migration and then migrating it drops the
same tables.
