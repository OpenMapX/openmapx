---
impacts: [breaking]
---

## What changes

Backup manifests start at backup format 1. A manifest records the release the
installation had applied (`release`: its id and manifest digest, or `null` when
the configuration pins none) and the newest migration the OpenMapX database had
applied (`databaseMigration`: `tag` and `when`, or `null` when the backup holds
no `postgis` dump). `tag` is `null` when neither the applied release nor the API
migration journal names the migration; the backup is still taken, since a
restore compares only `when`. Without a pinned release, backups and restores
that the operations agent runs use the migration journal its CLI was built
with. The `openmapxVersion` field, which held the extension
protocol version, and the hard-coded managed Dawarich provenance block are gone.

A restore of the OpenMapX database no longer compares extension protocol
versions. It refuses when the backup's migration is newer than the running
release's database migration head, the rule rollback already applies, and names
the backup's release to apply first. The admin backup list shows the applied
release instead of a platform version (`release` replaces `openmapxVersion` in
`GET /admin/services/backups`).

## Who is affected

Operators who create or restore backups, and clients of the admin backup list.

## Required action

None. Readers accept only format 1, so backups written by earlier development
builds are refused; take a new backup after updating.
