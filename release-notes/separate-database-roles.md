---
impacts: [breaking, migration, operator-action]
---

## What changes

`app-api` and `data-manager` no longer connect to PostgreSQL as the superuser.
`openmapx_api` owns the `public` schema and runs the migrations;
`openmapx_data_manager` may change only its own tables and the search and place
schemas it rebuilds, and can no longer read or change accounts, administrative
jobs or saved configuration. Martin's tile functions run as
`openmapx_tiles_owner`, which only reads OpenConditions' tables.
[Database roles](../docs/docs/install/configuration.md#database-roles) describes
the roles and their known limits.

`openmapx compose render` generates the role passwords once, in
`infra/docker/secrets/postgres-api-password` and
`infra/docker/secrets/postgres-data-manager-password`, and PostGIS creates or
updates the roles on every start. `POSTGRES_PASSWORD` remains the superuser's
password, used only for administration, backups and restores.

Database backups are now `pg_dump` archives (`<service>__<volume>.dump`) that
keep each object's owner and grants. The CLI refuses to restore an older
plain-SQL backup (`.sql.gz`) of the OpenMapX database; other services' older
backups still restore. [Backup & restore](../docs/docs/administration/backup-and-restore.md)
lists what a restore needs.

The shared `DATA_MANAGER_AUTH_TOKEN` is gone. The API, the operations agent and
the CLI on the host each present their own data-manager token from
`infra/docker/secrets/`. The API's token is refused with `403` on routes the
API does not use.

## Who is affected

Every Docker deployment that updates to this release. It is meant for a fresh
install: an existing database's tables belong to the superuser, so the API's
role could not migrate them.

Host-run development setups (`pnpm dev`) connect as the two roles and read the
token files. Scripts that called the data-manager with `DATA_MANAGER_AUTH_TOKEN`
must use the host CLI's token file, and scripts that read a backup's `.sql.gz`
file must read the `.dump` archive with `pg_restore`. Community services
configured with the superuser's connection URL keep working but can read and
change the whole platform.

## Required action

Install fresh from this release with an empty database volume. Run
`pnpm openmapx compose render` before starting the stack so the password and
token files exist. Remove `DATA_MANAGER_AUTH_TOKEN` from `infra/docker/.env`;
nothing reads it any more.

For host-run development, set `DATABASE_URL`, `DATABASE_PASSWORD_FILE` and the
data-manager token files in `apps/api/.env` and `services/data-manager/.env` as
their examples show.

After installing or upgrading OpenConditions, restart PostGIS or run the grants
in [Martin overlays](../docs/docs/guides/map-tiles.md#martin-overlays), or
traffic tiles fail with a permission error.

Give each community service that uses the shared database its own role with
only the access it needs, as [Community extensions](../docs/docs/administration/community-extensions.md)
describes, and change its `DATABASE_URL` to that role.
