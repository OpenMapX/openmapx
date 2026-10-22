---
impacts: [migration]
---

## What changes

The operations agent now fetches, installs and removes the community service
repositories that extensions bring, under `services/.community/`. Extensions
with community services can be installed in Docker deployments again; app-api
could not write that directory. An interrupted install or update is finished
or rolled back automatically by the next app-api start or extension change.

Database migration 0041 reshapes `service_repository`: it drops the unused
`display_name`, `last_fetched_at` and `auto_update` columns and records which
agent transaction installed each repository.

## Who is affected

Every deployment applies the migration at app-api startup. No deployment has
community service repositories installed today, because installing them has
not worked in Docker.

## Required action

None beyond a normal update, which replaces the app-api and ops-agent images
together. The migration cannot preserve existing `service_repository` rows and
fails if any exist. A deployment that somehow has rows should remove those
extensions before updating and reinstall them afterwards.
