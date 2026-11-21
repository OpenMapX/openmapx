---
impacts: [breaking, operator-action]
---

## What changes

The API and web services are now called `api` and `web`, like their images,
instead of `app-api` and `app-web`. Their compose services, containers
(`openmapx-api-1`, `openmapx-web-1`), service selections and CLI arguments use
the new names, for example `pnpm openmapx services restart api`.

The web app and data-manager reach the API through the alias `openmapx-api` on
the stack's own network. data-manager's API URL setting is now
`INTERNAL_API_URL`; `APP_API_BASE_URL` is no longer read. Behind an
operator-run Traefik, the router, service and middleware names in the
services' labels start with `openmapx-` (`openmapx-api`, `openmapx-web`, …).

A community service can no longer use the ID of a built-in service; inspecting
or installing a repository that declares one fails with
`Service id "…" belongs to a built-in service`.

## Who is affected

Every installation. Nothing is converted: a new installation starts with the
new names.

## Required action

Install from empty state: no database, volumes, `infra/docker/.env` or files
under `infra/docker` from an installation that used the old names. If you write
your own `infra/docker/.env`, name the services `api` and `web` in
`OPENMAPX_ENABLED_SERVICES`, and set `INTERNAL_API_URL` rather than
`APP_API_BASE_URL` if you override data-manager's API URL. Update scripts,
monitors and Traefik rules that name `app-api`, `app-web` or their containers.
