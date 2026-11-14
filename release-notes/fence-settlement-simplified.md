---
impacts: [breaking]
---

## What changes

The configuration fence that stops data jobs during an update or configuration
apply is now one row in Data Manager's database
(`data_manager.configuration_fence`). The operations agent prepares it and
settles it; both calls can be repeated safely after a lost reply. The signed
settlement records, Data Manager's private fence mirror and the separate
closure for a refused preparation are gone. A preparation Data Manager refuses
now fails like any other operation and releases its ownership.

## Who is affected

Installations upgrading from an earlier release. The fence's stored format
changed and no conversion is provided: earlier fence rows are removed by the
database migration.

## Required action

Install this release fresh, or upgrade only while no update or configuration
apply is in progress. Do not restore a database backup taken while an update or
configuration apply was running.
