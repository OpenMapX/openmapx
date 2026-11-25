---
impacts: [breaking, migration]
---

## What changes

The administrative and data job tables share one vocabulary, listed in
`@openmapx/core/jobs` and enforced by database `CHECK`s:

- Job statuses are `queued`, `running`, `cancel_pending`, `succeeded`, `failed`
  and `cancelled` for both `admin_job` and `data_manager.job`. A data job can
  also be `partially_succeeded` (it published without part of its work) or
  `interrupted` (its worker ended without a recorded outcome; recovery settles
  it, and it is never terminal). A data job a previous process left behind
  now ends `failed`. Transit stages record `succeeded`, `partially_succeeded`,
  `failed` or `skipped`. The Activity API, the job event stream and the
  data-manager execution API return these values unchanged; the former
  `success`, `ok`, `error`, `partial` and `canceled` are gone.
- Administrative job types follow `<area>.<object>.<verb>`. Renamed:
  `service.core-restart` → `service.core.restart`, `service.images.pull` →
  `service.image.pull`, `service.bulk` → `service.batch.run`, `data.operation` →
  `data.operation.run`, `backup.operation` → `backup.operation.run` and
  `system.diagnostics` → `system.diagnostics.collect`.
- A data job records what started it in `trigger` (`api`, `agent`, `cli`,
  `cron` or `bootstrap`, taken from the caller's data-manager token) and, for a
  job the API started for an administrator, `triggered_by_user_id`, a foreign
  key to the account that is cleared when the account is deleted. The free-form
  `triggered_by` column is gone; data-manager's transit routes accept
  `triggeredByUserId` from the API only, and the API's transit job listings
  return `trigger` and `triggeredByUserId`.
- The `data_manager` tables have singular names: `job`, `job_stage`,
  `offline_package_job`, `offline_package_job_owner` and
  `offline_package_artifact_reference`. `configuration_fence.state` is now
  `status`.

## Who is affected

Custom clients and scripts that read job statuses or types from the Activity
API, the data-manager API or the database, and operator SQL that names the old
`data_manager` tables.

## Required action

Update custom clients and SQL to the new names. The API baseline migration
creates the new schema; nothing installed predates it, so no data is converted.
