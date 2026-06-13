---
title: CLI reference
description: Every command group of the openmapx self-hosting CLI — services, compose, data, repos, integrations, users, backup, cache, check, poi-ingest, and transitous.
sidebar_position: 8
---

# CLI reference

`openmapx` is the operator's command-line front end for the whole self-hosting
workflow: discovering and selecting services, rendering the Docker Compose stack,
downloading and building data, managing community extensions, and the day-to-day
lifecycle of a running deployment. It's exposed as the `openmapx` bin from the
`@openmapx/cli` workspace package, so the canonical invocation from anywhere in
the repo is:

```bash
pnpm openmapx <command> [args]
```

Before it does anything, the CLI auto-loads `infra/docker/.env` — the same file
`docker compose` reads. That means `DOMAIN`, the shared secrets, and every
`SERVICE_<ID>_<KEY>` override are in scope for every command, so a render done by
the CLI and a `docker compose up` agree on configuration. The CLI runs directly
off TypeScript (no build step) and finds the repo root by walking up from your
working directory, so you can run it from any subdirectory.

This page is a flat reference to every command group and subcommand. The
day-to-day workflows behind them are covered in depth elsewhere — start with
[Managing services](../install/managing-services.md),
[Preparing data](../install/preparing-data.md), and
[Backup and restore](../administration/backup-and-restore.md) — and this page
links into those for the longer treatments.

## Notation

In the synopses below, `<arg>` is a required positional argument, `[arg]` is
optional, and `<arg...>` (or `[arg...]`) takes one or more values. Flags are
shown with their long form. Watch the difference in how the region is passed:
the `data` commands take it as a **positional** argument
(`data download osm europe/germany`), while the `services` build commands take it
as a **flag** (`services build motis --region europe/germany`).

## Environment

A few environment variables (read from `infra/docker/.env` or your shell) change
where the CLI points and how it authenticates:

| Variable | Default | Used by |
| --- | --- | --- |
| `DOMAIN` | `localhost` | the public domain baked into renders |
| `DATA_MANAGER_URL` | `http://localhost:4000` | the `data` and `poi-ingest` commands |
| `DATA_MANAGER_AUTH_TOKEN` | (unset) | bearer token for data-manager mutations |
| `OPENMAPX_API_URL` / `API_URL` | `http://localhost:3001` | the `repos` admin commands |
| `OPENMAPX_REGION` | (unset) | fallback region for `data` downloads/builds |
| `OPENMAPX_ENABLED_SERVICES` | (unset) | overrides the persisted service selection |

The data-manager and admin tokens are attached automatically when present, so
the commands below "just work" as long as the same secrets are set on both the
CLI side and the services.

## `services`

Discover, inspect, select, build, and run the backend services that make up a
deployment. The selection, preset, build, and lifecycle semantics are documented
in full under [Managing services](../install/managing-services.md).

| Command | Description |
| --- | --- |
| `services list` | List discovered services as a table. Filters: `--capability <cap>`, `--quality <built-in\|community-verified\|community>`, `--enabled`. |
| `services get <id>` | Print one service's full manifest as JSON. |
| `services selected` | Show the requested roots and the effective set after dependency expansion. |
| `services enable <ids...>` | Persistently add root services to `infra/docker/service-selection.json`. |
| `services disable <ids...>` | Persistently remove root services from the selection file. |
| `services build <ids...>` | Build prepared artifacts for the named services, then re-render and re-link. Flags: `--region <region>`, `--continue-on-error`. |
| `services build-all` | Build every service that declares a build, in order. Flags: `--region <region>`, `--fail-fast`. |
| `services start [ids...]` | Render, apply hardlinks, then `docker compose up -d` the named services. Flag: `--preset <names>`. |
| `services stop [ids...]` | `docker compose stop` the named services. Flag: `--preset <names>`. |
| `services restart [ids...]` | In-place reboot (`docker compose restart`); does **not** re-render. Flag: `--preset <names>`. |
| `services recreate [ids...]` | Re-render, link, pull images, then `up -d --force-recreate`. Flag: `--preset <names>`. |
| `services status [id]` | Container status table for one or all services (`docker compose ps`). |
| `services logs <id>` | Stream service logs. Flags: `--tail <n>` (default `100`), `--follow`. |
| `services capabilities` | Inventory the capability and data-type vocabulary across the registry. Flag: `--unrecognised`. |

`services enable` / `disable` refuse to edit the selection file when
`OPENMAPX_ENABLED_SERVICES` is set, so the source of truth stays unambiguous.
`--preset` expands a named bundle (`app`, `proxy`, `dev`, `routing`, `transit`,
`pelias`, `nominatim`, `photon`, `overpass`, `tiles`, `martin`); presets compose
and mix freely with explicit ids — see the
[preset table](../install/managing-services.md#presets).

## `compose`

Render and operate the generated Docker Compose stack. OpenMapX keeps no
hand-written compose file — the renderer derives it from the enabled manifests.

| Command | Description |
| --- | --- |
| `compose render` | Render `docker-compose.generated.yml` and the hardlink plan from the manifests. Flags: `--domain <d>` (default `$DOMAIN`), `--services <ids>`, `--preset <names>`. |
| `compose up` | Render, apply hardlinks, then `docker compose up -d` the whole selection. Flags: `--domain <d>`, `--services <ids>`, `--preset <names>`. |
| `compose down` | Stop the stack (`docker compose down`). Flag: `--volumes` removes named volumes (**destructive**). |
| `compose pull [ids...]` | Pull the latest images (no args pulls all services). |

For the difference between `services start` (a subset) and `compose up` (the
whole stack), and how `--services` overrides the persisted selection for a single
render, see [Rendering the stack](../install/managing-services.md#rendering-the-stack).

## `data`

Download source data, build prepared artifacts, and keep consumer directories
linked to producer data through the data-manager. The full workflow — regions,
hardlinks, authenticated feeds — lives in
[Preparing data](../install/preparing-data.md).

| Command | Description |
| --- | --- |
| `data download <kind> [region]` | Download source data. `kind` is `osm` (takes `[region]`), `gtfs`, or `style`. GTFS flags: `--countries <list>`, `--feeds-file <path>`. |
| `data build <kind> [region]` | Build prepared artifacts (alias for `services build`). `kind` is `motis`, `osrm`, `otp`, `pelias`, or `tiles`. |
| `data convert <kind> [region]` | Derive a secondary format from a download. `kind` is `overpass` (OSM PBF → bzip2). |
| `data update [region]` | Run the full refresh: download OSM + GTFS + style, build all artifacts, render, link. Flags: `--countries <list>`, `--feeds-file <path>`, `--fail-fast`. |
| `data link` | Re-render the hardlink plan from the current selection, then apply and prune it. |
| `data status` | Show the data-manager's tracked dataset inventory. Flag: `--offline` scans `infra/docker/data` directly. |
| `data add-feed <url> [slug]` | Download a single GTFS feed by URL (slug defaults to the URL basename). |
| `data remove-feed <slug>` | Remove a single GTFS feed by slug. |
| `data clean <target>` | Remove local data for one type alias (e.g. `osm`, `gtfs`, `style`, `osrm-graph`) or `all`. |
| `data generate-api-keys` | Generate the Transitous API-key template for feeds that require keys. Flags: `--repo-url <url>`, `--output <path>`. |

`data download osm`, `data build`, `data convert`, and `data update` fall back to
`$OPENMAPX_REGION` when you omit the region; without either, the region-bearing
commands error out asking for one. Regions use Geofabrik's path naming
(`europe/germany`, `north-america/us/california`, or `planet`).

## `repos`

Manage registered community **service** repositories. These commands call the
admin API (`$OPENMAPX_API_URL`, default `http://localhost:3001`), which
short-circuits authentication for loopback connections. See
[Community extensions](../administration/community-extensions.md) for the trust
model behind installing third-party services.

| Command | Description |
| --- | --- |
| `repos list` | List registered service repositories (URL, hash, last SHA, last fetch). |
| `repos add <url>` | Register a community service repository from a Git URL. Requires risk acknowledgment — pass `-y, --yes`, or answer the interactive prompt. Flag: `-y, --yes`. |
| `repos remove <hash>` | Unregister a repository and remove its local clone. |
| `repos refresh <hash>` | `git fetch` + `reset --hard` a registered repository, then re-validate every manifest; on failure the working tree is rolled back and the prior commit kept. |

Because community code runs with container (and, for integrations, in-process
API) privileges, `repos add` will not register a repository without an explicit
risk acknowledgment: in an interactive terminal it prompts for confirmation; in a
script or CI it refuses (exit 1, before any clone) unless you pass `--yes`. A
copy-pasted command can never silently register a repo.

## `integrations`

Manage community **integrations** under `custom_integrations/`. The CLI is the
only place integrations are built and packaged — the API container never builds
at runtime. The integration model is documented in
[Integration system](./integration-system.md).

| Command | Description |
| --- | --- |
| `integrations scaffold <id>` | Scaffold a new first-party integration under `integrations/<id>` from `integrations/_template/`, substituting the `__ID__`/`__DOMAIN__` tokens. Flag: `--domain <domain>`. Run `pnpm install` afterwards so pnpm picks up the new workspace package. See [Writing an integration](./writing-an-integration.md#quick-start-scaffold). |
| `integrations list` | List installed community integrations. Flag: `--include-built-in` also lists the first-party integrations under `integrations/`. |
| `integrations install <source>` | Install from a Git URL, local path, or prebuilt artifact. Flags: `--ref <ref>`, `--artifact`, `--sha256 <hash>`, `--no-build`. |
| `integrations remove <id>` | Remove a community integration. |
| `integrations validate [id]` | Validate one integration's manifest, or all if `id` is omitted. |
| `integrations build <id>` | Build the frontend and backend bundles for one integration. |
| `integrations package <source>` | Create a prebuilt `.tar.gz` artifact for admin/production installs. Requires `--out <file>`; `--no-build` requires existing dist bundles. |

After installing or removing an integration, restart `app-api` so the
integration host picks up the change:
`pnpm openmapx services restart app-api`.

## `users`

Manage user accounts directly against the PostGIS database (the commands run
`psql` inside the `postgis` container, so the stack must be up). Handy for
bootstrapping the first admin before SMTP is configured.

| Command | Description |
| --- | --- |
| `users list` | List registered users (id, email, name, role). |
| `users promote <email>` | Promote a user to admin by email. |
| `users demote <email>` | Remove the admin role from a user. |
| `users verify <email>` | Mark a user's email as verified — unblocks sign-in when SMTP isn't set up yet. |

The user must have signed up through the web UI first; these commands update an
existing row rather than creating one.

## `backup`

Create, list, restore, and delete on-disk backups of service volumes under
`infra/docker/backups/`. See
[Backup and restore](../administration/backup-and-restore.md) for what's included
and how restore swaps volumes safely.

| Command | Description |
| --- | --- |
| `backup create` | Back up every backup-enabled service volume. Flag: `--name <name>` (default: ISO timestamp). |
| `backup list` | List existing backups. |
| `backup restore <name>` | Restore a backup. Flags: `--services <ids...>` restricts to a subset; `--stop-running` stops the target services first. |
| `backup delete <name>` | Delete a backup directory. |

## `cache`

Inspect and clear the Redis cache. These commands run `redis-cli` inside the
`redis` container, so the stack must be running.

| Command | Description |
| --- | --- |
| `cache list` | List cache key namespaces and their counts. |
| `cache clear [target]` | Delete cached keys. `target` is an integration namespace (e.g. `geocoding`, expanded to `int:geocoding:*`) or a raw key glob (e.g. `cache:geocode*`). Flags: `--all` (FLUSHDB), `--dry-run`. |

A bare `cache clear geocoding` targets one integration's cache; pass `--all` (and
no target) to flush the entire database. `--dry-run` reports the match count
without deleting.

## `check`

```bash
pnpm openmapx check
```

Run health checks against the running services. It reads `docker compose ps`,
then fires in-network HTTP deep probes (from an ephemeral curl container on the
Compose network) that catch wedged-but-running states a plain healthcheck misses.
Pass `--no-probe` to skip the deep probes and report engine-level health only.
The command exits non-zero if any service is unhealthy, restarting, or fails its
probe.

## `poi-ingest`

Inspect and trigger the POI ingest sources (EV charging, parking, and the like)
that the data-manager runs. These commands talk to the data-manager at
`$DATA_MANAGER_URL`.

| Command | Description |
| --- | --- |
| `poi-ingest state` | Print the overall ingest state — counts by domain and status, in-flight jobs, recent failures. |
| `poi-ingest list` | List registered POI sources as a table. Flags: `--domain <name>`, `--status <active\|stale\|failed\|unknown>`. |
| `poi-ingest show <sourceId>` | Print full detail for one source (declaration, last run, recent jobs) as JSON. |
| `poi-ingest sync <sourceId>` | Trigger a sync for one source. Flags: `--live-only` (refresh the live cache only), `--idempotency-key <key>`. |

## `transitous`

Manage the pin of the [Transitous](https://github.com/public-transport/transitous)
GTFS catalog that the data-manager consumes, recorded in
`infra/docker/transitous.lock.json`.

| Command | Description |
| --- | --- |
| `transitous show` | Print the current lockfile contents. |
| `transitous bump` | Fetch the catalog, summarize the feed changes, and update the lockfile. Flags: `--yes` (skip the confirmation prompt), `--branch <name>` (default `main`). |

`transitous bump` reads from a catalog clone the data-manager maintains, so run a
GTFS download once (`pnpm openmapx data download gtfs`) before the first bump.
After bumping, restart the data-manager to pick up the new ref, or wait for the
next scheduled sync.

## Where to go next

- **[Getting started](../install/getting-started.md)** — the first-deployment
  walkthrough that strings these commands together.
- **[Managing services](../install/managing-services.md)** — selection, presets,
  rendering, and the service lifecycle in depth.
- **[Preparing data](../install/preparing-data.md)** — downloads, builds,
  regions, and hardlinks.
- **[Upgrading](../install/upgrading.md)** — pulling new images and re-rendering
  safely.
- **[Backup and restore](../administration/backup-and-restore.md)** — the backup
  workflow behind the `backup` commands.
