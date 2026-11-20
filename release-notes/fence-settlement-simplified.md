---
impacts: [breaking, migration]
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

Every installation. The fence's stored format changed and no conversion is
provided.

## Required action

Install fresh, as `update-system-fresh-install.md` describes. Do not restore a database backup taken while an update or
configuration apply was running.
