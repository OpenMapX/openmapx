---
impacts: [migration]
---

## What changes

Data-manager no longer starts work against a database the API has not
migrated yet. At startup it reads the API's migration history
(`drizzle.__drizzle_migrations`) and waits, for up to five minutes, until the
newest migration of its own release is applied; a newer schema satisfies it
too. Until then it serves nothing, `/status` included, and logs that it is
waiting for the API to migrate the database, so Compose may show it as
unhealthy for a while. When the wait runs out it exits, naming the migration
it expected and what it found and logging the `database-schema` startup phase,
and its supervisor restarts it. The API migration baseline grants the
`openmapx_data_manager` role `USAGE` on the `drizzle` schema and `SELECT` on
that table, and nothing else there.

## Who is affected

Installations that start data-manager before or without the API, and
operators reading data-manager's startup logs.

## Required action

None. The API applies the grant with its migrations; start the API of the same
release, or a newer one, so data-manager can finish starting.
