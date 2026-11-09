---
impacts: [migration]
---

## What changes

A database migration adds a unique index that allows only one active system update or
diagnostics job at a time. A second request while one is queued, running or being cancelled
now receives 409 instead of creating another job.

## Who is affected

Every installation. The migration fails if the database already holds two active jobs of
those types, which can only happen after a double-submitted update that is still running.

## Required action

None in normal operation: the migration runs with the update. Let any running update or
diagnostics job finish before updating.
