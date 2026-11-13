---
impacts: [breaking, migration, operator-action]
---

## What changes

`app-api` and `data-manager` no longer connect to PostgreSQL as the superuser.
Each has its own role: `openmapx_api` owns the `public` schema and runs the
migrations, and `openmapx_data_manager` may change only its own `data_manager`
tables and the search and place schemas it rebuilds. Data-manager can no longer
read or change accounts, administrative jobs or saved configuration.

`openmapx compose render` generates the two role passwords once, in
`infra/docker/secrets/postgres-api-password` and
`infra/docker/secrets/postgres-data-manager-password`. PostGIS creates or
updates both roles on every start. `POSTGRES_PASSWORD` remains the superuser's
password, used only by PostGIS administration and the CLI's backups and
restores.

A migration grants data-manager's role its tables. Database backups now keep
each object's owner and grants, and a restore keeps the live database's owner
and database-level grants.

The shared `DATA_MANAGER_AUTH_TOKEN` is gone. The API, the operations agent
(with the CLI commands it runs) and the CLI on the host each present their own
data-manager token, which the render generates in `infra/docker/secrets/`
(`data-manager-api-token`, `data-manager-ops-agent-token`,
`data-manager-host-cli-token`). The data-manager admits each caller only to the
routes it uses and answers `403` otherwise.

## Who is affected

Every Docker deployment that updates to this release. It is meant for a fresh
install: an existing database's tables belong to the superuser, so the API's
role could not migrate them.

Host-run development setups (`pnpm dev`) connect as the API's and
data-manager's roles too, and read the token files instead of
`DATA_MANAGER_AUTH_TOKEN`. Scripts that called the data-manager with that token
must use the host CLI's token file.

Community services that were configured with the superuser's connection URL
keep working, but should not: they can read and change the whole platform.

## Required action

Install fresh from this release with an empty database volume. Run
`pnpm openmapx compose render` before starting the stack so the password and
token files exist. Remove `DATA_MANAGER_AUTH_TOKEN` from `infra/docker/.env`;
nothing reads it any more.

For host-run development, set `DATABASE_URL`, `DATABASE_PASSWORD_FILE` and the
data-manager token files in `apps/api/.env` and `services/data-manager/.env` as
their examples show.

Give each community service that uses the shared database its own role with
only the access it needs, as [Community extensions](../docs/docs/administration/community-extensions.md)
describes, and change its `DATABASE_URL` to that role.
