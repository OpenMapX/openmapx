---
impacts: [breaking, operator-action]
---

## What changes

The administrator audit log is kept for 365 days by default instead of 90.
`RETENTION_AUDIT_LOG_DAYS` and `RETENTION_ADMIN_JOB_DAYS` must be whole numbers
between 1 and 36500: the API refuses to start with another value instead of
silently using the default. The daily prune of persisted application logs now
follows the server-log retention of the legal settings, as the privacy page
already stated: `RETENTION_SERVER_LOG_DAYS` when it is set, otherwise the
value set in the administration. The API service no longer sets that variable
to 30 when it is unset, which made the administration's value impossible to
apply. It must be a whole number between 1 and 3650 (before, up to 36500 was
accepted at startup).
The privacy page lists the audit log's period, and the data-access report
states the configured periods of the audit log, finished admin jobs,
application logs and privacy cases.

Martin reads its database connection from `MARTIN_DATABASE_URL` instead of
`DATABASE_URL`, which Martin 1.x reports as deprecated at every start and
Martin 2 ignores.

## Who is affected

Operators who set `RETENTION_AUDIT_LOG_DAYS`, `RETENTION_ADMIN_JOB_DAYS` or
`RETENTION_SERVER_LOG_DAYS`, who rely on the 90-day audit-log default,
who set the server-log retention in the administration, or who replaced the
release's Martin configuration with an
override under `infra/docker/overrides/services/martin/config/martin.yaml`. No
released installation exists.

## Required action

Set `RETENTION_AUDIT_LOG_DAYS=90` to keep the previous audit-log period, and
correct any retention value the API refuses at startup. In a Martin
configuration override, replace `$DATABASE_URL` with `$MARTIN_DATABASE_URL`.
