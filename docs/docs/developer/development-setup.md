---
title: Development setup
description: Run the OpenMapX web app and API in dev mode against local database and cache containers, and learn the everyday build, lint, type-check, and test commands.
sidebar_position: 2
---

# Development setup

Run the Next.js web app and Fastify API on your host with hot reload, backed by
local PostGIS and Valkey containers. This setup is for developing OpenMapX.
For a container deployment, follow [Getting started](../install/getting-started.md).

For the runtime model, read [How it works](../overview/how-it-works.md).

## Prerequisites

Install Node.js, pnpm, and Docker Engine with the Compose v2 plugin. The exact versions are listed under
[Requirements](../install/requirements.md) and pinned in the repo's root
`package.json` (`engines.node` and `packageManager`). The `openmapx` CLI runs
its TypeScript sources directly, so there is no global install and no build step
to bootstrap.

The CLI starts PostgreSQL and Valkey from the repository service manifests.
Keep ports `5432` and `6379` free. Existing containers and volumes may still use
older images or credentials; check their status when reusing an environment.

## Clone and install

```bash
git clone https://github.com/OpenMapX/openmapx.git
cd openmapx
pnpm install
```

The root install includes applications, shared packages, integrations, and the
`openmapx` CLI. Run `pnpm openmapx <command>` from the repository root.
The documentation site has a separate dependency set; install it with
`pnpm -C docs install --frozen-lockfile` when working on docs or preparing
full local verification.

## Start the database and cache

The repo ships a `dev` preset that boots only the two infrastructure services
the host-run app actually needs: `postgis` and `redis`. Both come from the same
images a deployment uses, so versions stay aligned.

The CLI renders the persisted service selection before starting the requested
subset. Its secret validation applies to the dev preset too. Create the
renderer environment and protect it:

```bash
cp infra/docker/.env.example infra/docker/.env
chmod 600 infra/docker/.env
pwd
```

Edit `infra/docker/.env` before starting services:

| Setting                   | Development value                                         |
| ------------------------- | --------------------------------------------------------- |
| `DOMAIN`                  | `localhost`                                               |
| `OPENMAPX_HOST_DIR`       | Absolute checkout path printed by `pwd`                   |
| `POSTGRES_PASSWORD`       | Unique password of at least 24 characters; not `postgres` |
| `BETTER_AUTH_SECRET`      | Separate random secret of at least 32 characters          |
| `DATA_MANAGER_AUTH_TOKEN` | Separate random token of at least 32 characters           |

Generate each credential separately with `openssl rand -hex 32`. Keep the
values stable when reusing database volumes. The last two credentials and the
host path are needed to validate/render the configuration even though this
preset starts only PostgreSQL and Valkey. The CLI loads this file itself; it
does not export the values to your shell or the host-run API.

Now start the two containers:

```bash
pnpm openmapx services start --preset dev
```

Both bind to `127.0.0.1`: PostgreSQL on `5432` and Valkey on `6379`.
They use named Docker volumes, so data survives container restarts. Check that
PostGIS is healthy before migrating. If startup fails, inspect its logs and
check the configured password and port availability:

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

In `apps/api/.env`, replace the example password in `DATABASE_URL` with the
`POSTGRES_PASSWORD` from `infra/docker/.env`. Keep the database/user and host
consistent with the dev preset:

```dotenv
DATABASE_URL=postgresql://postgres:YOUR_GENERATED_PASSWORD@localhost:5432/openmapx
```

Replace `YOUR_GENERATED_PASSWORD`; it is not a working credential. Hexadecimal
output from `openssl rand -hex 32` needs no URL escaping. Other passwords may
need percent-encoding in a connection URL.

The cache defaults are `REDIS_URL=redis://localhost:6379` and
`REDIS_PASSWORD_FILE=../../infra/docker/secrets/redis-password`. The file is
created when the CLI renders the authenticated Valkey service.

Copy the `BETTER_AUTH_SECRET` value into `apps/api/.env` as well. Generate a
separate vault key:

```bash
openssl rand -hex 32
```

Use that value for `OPENMAPX_SECRETS_KEY` in `apps/api/.env`; it must contain
exactly 64 hexadecimal characters. The integration host refuses startup without
it when discovered integrations declare vault-backed credentials. Keep the auth
and vault keys stable so existing sessions and encrypted credentials remain
usable. The host API does not need the data-manager token unless you also
configure it to call a data-manager.

Apply the committed migrations to the development database and start the server
with hot reload. Run these commands from the repository root:

```bash
cd apps/api
pnpm exec node --env-file=.env node_modules/drizzle-kit/bin.cjs migrate
pnpm dev
```

The migration command explicitly loads `.env`; bare `drizzle-kit migrate`
otherwise uses the exported `DATABASE_URL` or the config's default connection.
The API also applies pending committed migrations during startup and refuses to
start if a required migration fails. It listens on `http://localhost:3001`. `pnpm dev` runs the server under
`node --watch`, so it reloads imported source changes, including edits to
integrations under `integrations/`.

The package exposes a few schema helpers. Use the committed migrations for a
working development database: `db:push` synchronizes the declared schema but does
not replay custom SQL migrations.

```bash
pnpm db:generate    # generate a migration from schema changes
pnpm db:push        # schema-only experiment on a disposable database
pnpm db:studio      # open Drizzle Studio, a visual database browser
pnpm auth:generate  # regenerate the Better Auth schema
```

## Run the web app

Open a second terminal at the repository root. The frontend reads a Next.js env
file; copy the example to `.env.local`:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Keep `NEXT_PUBLIC_API_URL=http://localhost:3001` for the API started above.
Use `http://localhost:3000` for the web app, matching the API's default
`CORS_ORIGIN` and authentication origin configuration. If you change either
origin or port, update those settings together. The
default OpenMapX style uses keyless OpenFreeMap when the API has no MapTiler key.
A configured server-side `MAPTILER_KEY` in `apps/api/.env` or admin settings
selects MapTiler in `auto` mode; the key never enters the browser bundle. Override
the hosted choice with `BASEMAP_PROVIDER` or admin settings. Enabled TileServer GL
or explicit self-hosted tile URLs always take priority.

Start the dev server:

```bash
cd apps/web
pnpm dev
```

The web app runs on `http://localhost:3000`.

Startup also builds the junction-photo alignment worker as a standalone browser
asset. After changing its source or the core photo-registration helpers while
the dev server is running, run `pnpm -C apps/web build:photo-worker` from the
repository root and reload the page. Production builds regenerate it automatically.

:::note[Street-level imagery]
Street-level imagery works out of the box: the default provider is Panoramax,
which needs no credentials. Imagery is proxied through the API, so no provider
token is bundled into the browser JavaScript.

Mapillary is available as an opt-in extra: enable it in the admin panel and set
its access token, and its coverage joins the layer. Review Mapillary's Terms
first; they restrict use in connection with real-time navigation or route
guidance.
:::

## Run both at once

From the repository root, filter the development task to the web and API:

```bash
pnpm dev --filter=web --filter=@openmapx/api
```

This starts web on `3000` and API on `3001`. Bare `pnpm dev` also selects
`ops-agent`, `transitous-runner`, and `data-manager`, which require their own
configuration. Use the filtered command for this two-process setup.
Running each app in its own terminal is equally fine, and often clearer when you
are watching one of them closely.

| Process | Port | URL                         |
| ------- | ---- | --------------------------- |
| Web app | 3000 | `http://localhost:3000`     |
| API     | 3001 | `http://localhost:3001`     |
| PostGIS | 5432 | `postgres://localhost:5432` |
| Redis   | 6379 | `redis://localhost:6379`    |

## Optional self-hosted backends

The dev preset starts only PostgreSQL and Valkey. Local routing, geocoding,
transit, and OSM-query engines require explicit service selection and prepared
source data. `services start <id>` does not enable an unselected service;
`services enable <id>` changes the persisted selection. Follow
[Managing services](../install/managing-services.md) and
[Preparing data](../install/preparing-data.md) before starting an engine.

There is also a network boundary: the service registry resolves a bound engine
to its Docker hostname, such as `http://valhalla:8002`. The host-run API above
cannot resolve that name. An integration's endpoint override may have lower
precedence than its service binding, so setting a loopback URL alone does not
repair an active Docker binding.

For development that uses bound engines, run the API and engines together on
the generated Docker network using the
[managed deployment workflow](../install/getting-started.md). Use the host-run
setup for work against separately supported hosted providers. Verify each
adapter's endpoint and binding precedence before configuring a different
arrangement. See [Architecture](./architecture.md) and the
[integration system](./integration-system.md) for the resolution contract.

## Everyday commands

Run these from the repository root. Build and type-check commands use Turbo;
lint, formatting, and Vitest run through their own root scripts.

```bash
pnpm build         # build every app and package
pnpm check-types   # type-check with tsc, no emit
pnpm lint          # Biome, Markdown/YAML formatting, and translations
pnpm format        # Biome + Markdown/YAML formatting (writes in place)
pnpm test          # run the Vitest suite once
```

Tooling notes:

- **Biome** handles both linting and formatting (config in `biome.json`):
  two-space indent, double quotes, a 100-column line width, and import
  organization. `pnpm format` rewrites files; `pnpm lint` checks without
  writing. Prettier formats Markdown and YAML; Biome owns the other supported
  source files.
- **Vitest** runs the tests from a single root config (`vitest.config.ts`),
  split into two projects: `node` (API, integrations, packages, services) and
  `web` (the Next.js app and React-bound packages, in jsdom). All test commands
  run from the repo root:
  - `pnpm test`: run the whole suite once
  - `pnpm discovery-eval --out /tmp/openmapx-eval`: run the versioned offline
    [discovery evaluation](discovery-evaluation.md) and save a comparison report
  - `pnpm test:watch`: watch mode
  - `pnpm test:coverage`: run with a V8 coverage report (written to `coverage/`)
  - `pnpm test --project web` / `--project node`: scope to one environment
  - `pnpm exec vitest run <path-or-name>`: scope to specific files (e.g.
    `pnpm exec vitest run packages/core`)

  Scope Vitest with a path/name filter from the repository root. The native
  mobile app has a separate Jest and native test workflow, described below.

- **Type-checking** is per-package via `pnpm check-types`. The API and web both
  type-check their integration and service-worker configs in addition to the
  main project.

## Native mobile development

`apps/mobile` is an Expo native host with its own platform setup. It is not
started by `pnpm dev`. Use the [mobile architecture](./mobile-architecture.md)
and [mobile release guide](./mobile-release.md) for configuration, generated
native projects, permissions, and device qualification.

```bash
pnpm mobile:doctor          # check the Expo/native toolchain
pnpm mobile:verify          # Jest, native tests, types, and doctor
pnpm mobile:prebuild:check   # verify clean native generation separately
pnpm mobile:bundle:check    # check the background bundle separately
```

These checks require the platform tooling described in the mobile guides. A
passing portable Vitest run does not establish native build, permission,
background-location, or physical-device behavior.

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

The Husky `pre-commit` hook checks staged source files with Biome and staged
Markdown/YAML with Prettier. It checks an index snapshot without editing or
staging files. The `commit-msg` hook checks the commit message. A successful
commit does not establish that types, tests, or policy checks pass; run the
checks appropriate to your change. There is no pre-push gate. Hooks are installed
by the root `prepare` script during `pnpm install`. See the
[contribution quality bar](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#quality-bar)
for full local verification and checks that run separately.

## Where to go next

- [Map comparison baseline](./map-comparison-baseline.md): fixed German
  camera, search and place-sheet checks for visual and discovery changes.

- [Architecture](./architecture.md): how the services, integrations, and
  capability bindings fit together.
- [Integration system](./integration-system.md): the manifest schema and
  the typed contracts integrations implement.
- [Writing an integration](./writing-an-integration.md): a hands-on guide
  to building your own feature.
- [CLI reference](./cli-reference.md): every `pnpm openmapx` command,
  including the data and service-lifecycle ones this page only touched on.
