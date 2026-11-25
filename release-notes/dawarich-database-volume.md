---
impacts: [breaking]
---

## What changes

The managed Dawarich database (`dawarich-postgis`) mounts its named volume at
`/var/lib/postgresql` instead of `/var/lib/postgresql/data`. Its PostgreSQL 18
image keeps `PGDATA` at `/var/lib/postgresql/18/docker`, which the old mount
did not contain, so the timeline database did not live in the named volume.

## Who is affected

Installations that enable managed Dawarich.

## Required action

None for a new installation. The named volume now holds the timeline database
and survives container recreation.
