---
impacts: [security, operator-action]
---

## What changes

The built-in Nominatim geocoder no longer receives the PostgreSQL superuser's
password (`POSTGRES_PASSWORD`). Its bundled database now uses its own
password, `NOMINATIM_DB_PASSWORD` from `infra/docker/.env`. Nominatim does not
render without it, and the CLI rejects a value that is shorter than 24
characters, a known placeholder or the same as `POSTGRES_PASSWORD`.

## Who is affected

Deployments that enabled the built-in Nominatim service. Others need no
action.

## Required action

Before the next render, set `NOMINATIM_DB_PASSWORD` in `infra/docker/.env` to
a new value, generated with `openssl rand -hex 32`.

The Nominatim image applies this password when it first imports its database.
An existing import keeps its previous password until Nominatim is imported
again.

Because earlier releases handed the superuser's password to the Nominatim
container, rotate `POSTGRES_PASSWORD` on every deployment that ran Nominatim:
set a new value in `infra/docker/.env`, recreate PostGIS and check that it
reports healthy, as described in
[Supporting infrastructure](../docs/docs/guides/supporting-infrastructure.md#the-password).
