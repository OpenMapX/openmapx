---
title: Development setup
description: Run the OpenMapX web app and API in dev mode against local database and cache containers, and learn the everyday build, lint, type-check, and test commands.
sidebar_position: 2
---

# Development setup

This page sets up a local environment for working **on** OpenMapX. It is
different from [Getting started](../install/getting-started.md), which deploys
the full stack as Docker containers. Here, you run the two application
processes — the Next.js frontend and the Fastify API — directly on your host
with hot reload, and back them with just two infrastructure containers,
PostGIS and Redis.

If you only want to deploy OpenMapX, follow [Getting started](../install/getting-started.md)
instead. If you want to understand how the pieces fit together first, read
[How it works](../overview/how-it-works.md).

## Prerequisites

You need the same host tooling as a deployment — Node.js, pnpm, and a Docker
Engine with the Compose v2 plugin. The exact versions are listed under
[Requirements](../install/requirements.md) and pinned in the repo's root
`package.json` (`engines.node` and `packageManager`). The `openmapx` CLI runs
its TypeScript sources directly, so there is no global install and no build step
to bootstrap.

You will not install PostgreSQL or Redis on the host. The CLI starts them as
Docker containers from the same manifests a production deployment uses, so your
dev database and cache never drift from production versions.

## Clone and install

```bash
git clone https://github.com/OpenMapX/openmapx.git
cd openmapx
pnpm install
```

A single `pnpm install` at the repo root wires up the whole workspace — every
app, package, and integration — plus the `openmapx` CLI, which you invoke as
`pnpm openmapx <command>` from the root.

## Start the database and cache

The repo ships a `dev` preset that boots only the two infrastructure services
the host-run app actually needs: `postgis` and `redis`. Both come from the same
images a deployment uses, so versions stay aligned.

First, set a database password. The PostGIS container refuses to boot without
one — there is no default. The Docker stack reads exactly one environment file,
`infra/docker/.env`, so copy the example and set the password there:

```bash
cp infra/docker/.env.example infra/docker/.env
```

Open `infra/docker/.env` and set `POSTGRES_PASSWORD`. For local development a
simple value like `postgres` is fine:

```bash
POSTGRES_PASSWORD=postgres
```

The other variables in that file (`DOMAIN`, `OPENMAPX_HOST_DIR`,
`BETTER_AUTH_SECRET`, and so on) are only consumed by the full self-hosting
stack. The `dev` preset boots only PostGIS and Redis and ignores them.

Now start the two containers:

```bash
pnpm openmapx services start --preset dev
```

Both bind their ports to `127.0.0.1` — PostgreSQL on `5432`, Redis on `6379` —
and persist data in named Docker volumes, so your database survives restarts.
A few useful follow-ups:

```bash
pnpm openmapx services status              # show running containers
pnpm openmapx services logs postgis -f     # tail one service's logs
pnpm openmapx services stop --preset dev   # stop without removing data
```

## Run the API

The API reads its own environment file, `apps/api/.env`. Copy the example:

```bash
cp apps/api/.env.example apps/api/.env
```

The defaults already match the `dev` preset — `DATABASE_URL` points at
`postgres:postgres@localhost:5432/openmapx` and `REDIS_URL` at
`redis://localhost:6379`. If you set `POSTGRES_PASSWORD` to anything other than
`postgres`, update the password segment of `DATABASE_URL` to match. Set a
`BETTER_AUTH_SECRET` (any string of at least 32 characters works for dev; the
example notes the `npx @better-auth/cli@latest secret` generator).

Apply the database schema and start the server with hot reload:

```bash
cd apps/api
pnpm db:push
pnpm dev
```

The API listens on `http://localhost:3001`. `pnpm dev` runs the server under
`node --watch`, so it reloads on source changes — including edits to
integrations under `integrations/`.

The package exposes a few schema helpers worth knowing:

```bash
pnpm db:generate    # generate a migration from schema changes
pnpm db:push        # push the schema directly (dev shortcut)
pnpm db:studio      # open Drizzle Studio, a visual database browser
pnpm auth:generate  # regenerate the Better Auth schema
```

## Run the web app

The frontend reads a Next.js env file. Copy the example to `.env.local`:

```bash
cp apps/web/.env.example apps/web/.env.local
```

The one value that matters for local development is `NEXT_PUBLIC_API_URL`, which
already defaults to `http://localhost:3001` — the API you just started. Default
map rendering goes through the API's MapTiler proxy, so the MapTiler key lives
server-side as `MAPTILER_KEY` in `apps/api/.env`, not in the browser bundle. Set
it there if you want hosted map tiles; you can also leave it unset and self-host
tiles later.

Start the dev server:

```bash
cd apps/web
pnpm dev
```

The web app runs on `http://localhost:3000`.

:::note[Optional street-level imagery]
The in-browser street-level imagery viewer needs a Mapillary client token in
`NEXT_PUBLIC_MAPILLARY_TOKEN`. It is bundled into the public JavaScript by
design — use a dedicated, low-quota Mapillary app for it, never the server-side
`MAPILLARY_TOKEN`. Leave it unset and the on-map entry point is simply hidden.
:::

## Run both at once

From the repo root, `turbo` can drive both dev servers together:

```bash
pnpm dev
```

This runs the `dev` task across the workspace (web on `3000`, API on `3001`).
Running each app in its own terminal is equally fine, and often clearer when you
are watching one of them closely.

| Process | Port | URL |
| ------- | ---- | --------------------------- |
| Web app | 3000 | `http://localhost:3000` |
| API     | 3001 | `http://localhost:3001` |
| PostGIS | 5432 | `postgres://localhost:5432` |
| Redis   | 6379 | `redis://localhost:6379` |

## Optional self-hosted backends

The `dev` preset only boots PostGIS and Redis. Features that depend on
self-hosted routing, geocoding, transit, or OSM queries need their services
running too. Start them through the same CLI, on top of the dev preset:

```bash
pnpm openmapx services start valhalla osrm   # routing
pnpm openmapx services start motis           # transit
pnpm openmapx services start --preset routing # or a whole preset
```

Without them, integrations that require those backends report as unhealthy or
unconfigured, but the rest of the app works against external APIs. Bringing up
self-hosted engines also involves downloading and building source data — see
[Getting started](../install/getting-started.md) and the
[CLI reference](./cli-reference.md) for the data and build commands. For how
services, integrations, and capabilities relate, see
[Architecture](./architecture.md) and the
[integration system](./integration-system.md).

## Everyday commands

All of these run from the repo root and fan out across the workspace via
`turbo`. They are the same checks CI runs.

```bash
pnpm build         # build every app and package
pnpm check-types   # type-check with tsc, no emit
pnpm lint          # Biome lint + check (also runs translation checks)
pnpm format        # format the whole repo with Biome (writes in place)
pnpm test          # run the Vitest suite once
```

Tooling notes:

- **Biome** handles both linting and formatting (config in `biome.json`):
  two-space indent, double quotes, a 100-column line width, and import
  organization. `pnpm format` rewrites files; `pnpm lint` checks without
  writing.
- **Vitest** runs the tests. The root `pnpm test` covers the API, web,
  integrations, packages, and services. Within `apps/api` you also get
  `pnpm test:watch` and `pnpm test:coverage`.
- **Type-checking** is per-package via `pnpm check-types`. The API and web both
  type-check their integration and service-worker configs in addition to the
  main project.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by commitlint through a Husky `commit-msg` hook. Messages take the
`type(scope): subject` form, where `type` is one of `feat`, `fix`, `chore`,
`docs`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, or `revert`. The
header is capped at 100 characters and the subject must not be start-, pascal-,
or upper-case.

```text
feat(routing): add walking profile to the directions panel
fix(transit): handle empty MOTIS itinerary response
docs(developer): document the dev setup flow
```

A Husky `pre-commit` hook also runs the lint, type-check, legal-table, data-flow,
and test gates before each commit, so a clean commit means those checks already
passed locally. Both hooks are installed automatically by the `prepare` script
the first time you run `pnpm install`.

## Where to go next

- **[Architecture](./architecture.md)** — how the services, integrations, and
  capability bindings fit together.
- **[Integration system](./integration-system.md)** — the manifest schema and
  the typed contracts integrations implement.
- **[Writing an integration](./writing-an-integration.md)** — a hands-on guide
  to building your own feature.
- **[CLI reference](./cli-reference.md)** — every `pnpm openmapx` command,
  including the data and service-lifecycle ones this page only touched on.
