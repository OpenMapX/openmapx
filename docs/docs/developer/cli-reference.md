---
title: CLI reference
description: Commands and authentication for service management, data jobs, extensions, backups, and catalog pins.
sidebar_position: 8
---

# CLI reference

Run the self-hosting CLI from the repository root:

```bash
pnpm openmapx <command> [args]
pnpm openmapx --help
pnpm openmapx ext install --help
```

The root script invokes the TypeScript sources through `tsx`; no separate CLI
build or global installation is required. The CLI loads `infra/docker/.env`
when it exists. Values already exported in the shell take precedence.

For complete workflows, see [Managing services](../install/managing-services.md),
[Preparing data](../install/preparing-data.md), and
[Backup and restore](../administration/backup-and-restore.md).

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

| Variable                       | Default                 | Used by                                     |
| ------------------------------ | ----------------------- | ------------------------------------------- |
| `DOMAIN`                       | `localhost`             | the public domain baked into renders        |
| `DATA_MANAGER_URL`             | `http://localhost:4000` | the `data` commands                         |
| `DATA_MANAGER_AUTH_TOKEN`      | (unset)                 | bearer token for data-manager mutations     |
| `API_URL` / `OPENMAPX_API_URL` | `http://localhost:3001` | the `ext` admin commands                    |
| `OPENMAPX_REGION`              | (unset)                 | fallback region for `data` downloads/builds |
| `OPENMAPX_ENABLED_SERVICES`    | (unset)                 | overrides the persisted service selection   |

`ext` sends the `x-openmapx-local-admin` header, using
`OPENMAPX_LOCAL_ADMIN_TOKEN` when configured. The local administrator path
requires a loopback connection and the API's matching token policy. Production
requires a configured token; `OPENMAPX_DISABLE_LOCALHOST_AUTH=1` disables this
path. The managed API service does not publish port 3001 on the host, so the
default CLI endpoint is unavailable in that deployment. Use the authenticated
admin UI there. Pointing the CLI at a remote host does not grant administrator
access. `API_URL` takes
precedence over `OPENMAPX_API_URL`. Data-manager commands send the configured
bearer token. See [Users and access](../administration/users-and-access.md).

## `services`

Discover, inspect, select, build, and run the backend services that make up a
deployment. The selection, preset, build, and lifecycle semantics are documented
in full under [Managing services](../install/managing-services.md).

| Command                     | Description                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services list`             | List discovered services as a table. Filters: `--capability <cap>`, `--quality <built-in\|community-verified\|community>`, `--enabled`.                                                                                                             |
| `services get <id>`         | Print one service's full manifest as JSON.                                                                                                                                                                                                          |
| `services selected`         | Show the requested roots and the effective set after dependency expansion.                                                                                                                                                                          |
| `services enable <ids...>`  | Persistently add root services to `infra/docker/service-selection.json`.                                                                                                                                                                            |
| `services disable <ids...>` | Persistently remove root services from the selection file.                                                                                                                                                                                          |
| `services build <ids...>`   | Build prepared artifacts for the named services, then re-render and re-link. Flags: `--region <region>`, `--continue-on-error`, `--import` (MOTIS only: also run `motis import`).                                                                   |
| `services build-all`        | Build every service that declares a build, in order. Flags: `--region <region>`, `--fail-fast`.                                                                                                                                                     |
| `services start [ids...]`   | Render, apply hardlinks, then `docker compose up -d` the named services. Flag: `--preset <names>`.                                                                                                                                                  |
| `services stop [ids...]`    | `docker compose stop` the named services. Flag: `--preset <names>`.                                                                                                                                                                                 |
| `services restart [ids...]` | In-place reboot (`docker compose restart`); does **not** re-render. Flag: `--preset <names>`.                                                                                                                                                       |
| `services update [ids...]`  | Re-render, link, pull the configured images, then replace containers with `up -d --force-recreate`. Flag: `--preset <names>`. For core OpenMapX app releases, use the aggregate release-manifest procedure in [Upgrading](../install/upgrading.md). |
| `services status [id]`      | Container status table for one or all services (`docker compose ps`).                                                                                                                                                                               |
| `services logs <id>`        | Stream service logs. Flags: `--tail <n>` (default `100`), `--follow`.                                                                                                                                                                               |
| `services capabilities`     | Inventory the capability and data-type vocabulary across the registry. Flag: `--unrecognised`.                                                                                                                                                      |

`services enable` / `disable` refuse to edit the selection file when
`OPENMAPX_ENABLED_SERVICES` is set, so the source of truth stays unambiguous.
`--preset` expands a named bundle (`app`, `proxy`, `dev`, `routing`, `transit`,
`pelias`, `nominatim`, `photon`, `overpass`, `tiles`, `martin`); presets compose
and mix freely with explicit ids — see the
[preset table](../install/managing-services.md#presets).

## `compose`

Render and operate the generated Docker Compose stack. OpenMapX keeps no
hand-written compose file — the renderer derives it from the enabled manifests.

| Command                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose render`                | Apply the selection as a new configuration generation: compose file and hardlink plan from the manifests, with the settings and credentials the admin panel last applied. Flags: `--domain <d>` (default `$DOMAIN`), `--services <ids>`, `--preset <names>`.                                                                                                                                                                                                                                                      |
| `compose up`                    | Render, apply hardlinks, resolve the release overlay if it is missing, then `docker compose up -d` the whole selection. Flags: `--domain <d>`, `--services <ids>`, `--preset <names>`.                                                                                                                                                                                                                                                                                                                            |
| `compose release`               | Resolve `OPENMAPX_RELEASE` (main, preview, exact version/digest; default main) and write `infra/docker/docker-compose.release.yml`, pinning the seven product images: API, web, data-manager, ops-agent, privacy-backup, Transitous runner, and Transitous tools. `--status` inspects local pins without registry access; `--clear` clears local selection without changing running containers. Lifecycle commands include the selected overlay. `OPENMAPX_RELEASE=local` explicitly disables release resolution. |
| `compose down`                  | Stop the stack (`docker compose down`). Flag: `--volumes` removes named volumes (**destructive**).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `compose pull [ids...]`         | Pull the selected images (no args pulls all services); resolve or preserve a coherent overlay for product services. For core OpenMapX app releases, use the aggregate release-manifest procedure in [Upgrading](../install/upgrading.md).                                                                                                                                                                                                                                                                         |
| `compose rotate-redis-password` | Replace the password and reconcile its ACL while Redis clients are stopped. Each file is replaced atomically; the pair is not one transaction. Flag: `--confirm-clients-stopped`. Follow the [rotation procedure](https://github.com/OpenMapX/openmapx/blob/main/infra/docker/secrets/README.md#redis-password-and-redis-aclconf-generated).                                                                                                                                                                      |

For the difference between `services start` (a subset) and `compose up` (the
whole stack), and how `--services` overrides the persisted selection for a single
render, see [Rendering the stack](../install/managing-services.md#rendering-the-stack).

## `data`

Download source data, build prepared artifacts, and keep consumer directories
linked to producer data through the data-manager. The full workflow — regions,
hardlinks, authenticated feeds — lives in
[Preparing data](../install/preparing-data.md).

| Command                            | Description                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data download <kind> [region]`    | Download source data. `kind` is `osm` (takes `[region]`), `fonts`, or `gtfs`. The `gtfs` spelling starts the same transactional sync as `data sync`; its only feed flag is `--countries <list>`. |
| `data build <kind> [region]`       | Build prepared artifacts (alias for `services build`). `kind` is `motis`, `osrm`, `otp`, `pelias`, or `tileserver`.                                                                              |
| `data convert <kind> [region]`     | Derive a secondary format from a download. `kind` is `overpass` (OSM PBF → bzip2).                                                                                                               |
| `data update [region]`             | Run the full refresh: download OSM, transactionally sync transit sources, download glyph fonts, build artifacts, render, and link. Flags: `--countries <list>`, `--fail-fast`.                   |
| `data sync`                        | Queue a transactional transit-source sync. Flag: `--countries <list>`. The command returns a job id; promotion changes the active set only after the candidate passes.                           |
| `data source list`                 | List requested and active transit sources together with origin, region, and lifecycle state.                                                                                                     |
| `data source add <url>`            | Add an operator source and queue a sync. Required: `--name`, `--region`, `--attribution`, plus `--license-spdx` or `--license-url`.                                                              |
| `data source remove <sourceId>`    | Disable a desired source and queue a sync. Catalog sources remain known and can be re-enabled.                                                                                                   |
| `data source enable <sourceId>`    | Re-enable a disabled catalog source and queue a sync.                                                                                                                                            |
| `data export <service> <bundle>`   | Write a built artifact (`tileserver`, `osrm`, `otp`, `pelias`, `motis`) and its checksummed manifest as a tar bundle. `-` streams to stdout.                                                     |
| `data import <bundle>`             | Verify a bundle from `data export` (`-` reads stdin), check its runtime images match this host, swap it in, then render and link.                                                                |
| `data link`                        | Re-render the hardlink plan from the current selection, then apply and prune it.                                                                                                                 |
| `data status`                      | Show the data-manager's tracked dataset inventory. Flag: `--offline` scans `infra/docker/data` directly.                                                                                         |
| `data clean <target>`              | Remove local data for one type alias (e.g. `osm`, `gtfs`, `fonts`, `osrm-graph`) or `all`.                                                                                                       |
| `data generate-api-keys`           | Generate the Transitous API-key template for feeds that require keys. Flags: `--repo-url <url>`, `--output <path>`.                                                                              |
| `data overture-sync [region]`      | Run the release-pinned regional refresh: pull and atomic ingest, then start the independently retryable OSM↔GERS link rebuild.                                                                   |
| `data overture-pull [region]`      | Resolve exact Overture Places assets through STAC, pull a regional Parquet snapshot, and write its validated release contract.                                                                   |
| `data overture-ingest [region]`    | Verify the regional release contract and ingest its Overture Places snapshot into PostGIS.                                                                                                       |
| `data overture-conflate [region]`  | Resume the installed release's durable extraction, scoring, exact assignment, or publication phase. Flag: `--restart` deliberately discards saved phases and starts from extraction.             |
| `data overture-status`             | Show the installed release, durable phase, cursors, counts, timings, heartbeat age, and last error.                                                                                              |
| `data overture-extract [region]`   | Stream OSM POIs from the local PBF and atomically replace `overture_places.osm_pois` (diagnostic/manual use).                                                                                    |
| `data search-index build [region]` | Stream the selected OSM PBF into a staged alias/reference/acronym index, validate it, and publish it atomically.                                                                                 |
| `data search-index status`         | Show the active index region, health/staleness, epoch, row counts, fingerprints, timestamps, and last build error.                                                                               |
| `data notable-places build`        | Fetch the places many Wikipedias cover from Wikidata and publish them atomically for search ranking.                                                                                             |
| `data notable-places status`       | Show the published notable-places snapshot: counts, sitelink threshold, source endpoint, epoch, and last error.                                                                                  |

`data download osm`, `data build`, `data convert`, and `data update` fall back to
`$OPENMAPX_REGION` when you omit the region; without either, the region-bearing
commands error out asking for one. Regions use Geofabrik's path naming
(`europe/germany`, `north-america/us/california`, or `planet`).

The search-index build requires the region's PBF to be registered with the
data-manager first. It supports one active region (or `planet`) and never runs
implicitly during API startup. Downloading a newer PBF marks the published
index stale; run the build command again when you are ready to pay the CPU,
database, and temporary-disk cost.

## `ext`

Browse and manage bundles of declarative integrations and isolated services.
These commands use the admin API and its local administrator policy described
above. See [Community extensions](../administration/community-extensions.md)
for installation, host-port exposure, and recovery.

| Command                 | Description                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ext browse`            | List catalog entries. Flags: `-q, --query <text>`, `--trust <verified\|community>`, `--type <service\|integration>`.                                          |
| `ext list`              | List installed extensions and update information. Local inventory remains available when optional catalog enrichment fails; update status can be unavailable. |
| `ext preview <idOrUrl>` | Resolve and inspect the current component snapshot, effective host ports, and confirmation fingerprint. Preview can fetch and stage repositories.             |
| `ext install <idOrUrl>` | Preview and queue installation by catalog ID or `extension.json` URL.                                                                                         |
| `ext update <id>`       | Preview and queue an update from the current catalog entry.                                                                                                   |
| `ext remove <id>`       | Queue removal of the installed bundle's services and integrations.                                                                                            |

For an install or update that exposes host ports, inspect the preview and supply
its exact fingerprint with `--host-port-confirmation <fingerprint>`. An updated
snapshot requires a new review. A preview alone does not authorize exposure.

```bash
pnpm openmapx ext preview openconditions
pnpm openmapx ext install openconditions
```

The install command can require the confirmation flag after preview; it does not
silently approve ports. A returned job ID means the operation was queued. Check
**Admin → Activity** for completion, failure, and any cleanup work. If a request
times out, the server job may still be running: inspect Activity before retrying.
Do not assume that every failed operation has fully rolled back.

Service components execute container code. Integration artifacts are declarative
and cannot install executable API, web, or data-manager entry points. Review the
source and requested access before installing either component type.

## `integrations`

The developer-side build/package tooling for integrations (distinct from the
`ext` store above) — the CLI is the only place integrations are built and
packaged; the API container never builds at runtime. The integration model is
documented in [Integration system](./integration-system.md).

| Command                         | Description                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations scaffold <id>`    | Scaffold a new first-party integration under `integrations/<id>` from `integrations/_template/`, substituting the `__ID__`/`__DOMAIN__` tokens. Flag: `--domain <domain>`. Run `pnpm install` afterwards so pnpm picks up the new workspace package. See [Writing an integration](./writing-an-integration.md#quick-start-scaffold).                                             |
| `integrations list`             | List installed community integrations. Flag: `--include-built-in` also lists the first-party integrations under `integrations/`.                                                                                                                                                                                                                                                 |
| `integrations install <source>` | Install a declarative integration from a Git URL, local path, or artifact through the operations agent, which records it. Local and Git sources are packaged on the host first. Flags: `--ref <ref>`, `--artifact`, `--sha256 <hash>`. Executable runtime entry points are rejected. Without a running agent (development) it installs directly, and the agent will not load it. |
| `integrations remove <id>`      | Remove a community integration through the operations agent. Only an integration installed with this command, not one an extension installed, can be removed this way.                                                                                                                                                                                                           |
| `integrations validate [id]`    | Validate one integration's manifest, or all if `id` is omitted.                                                                                                                                                                                                                                                                                                                  |
| `integrations package <source>` | Create a declarative `.tar.gz` artifact for admin/production installs. Requires `--out <file>`; all executable runtime entry points are rejected. Only the declared artifact contract is packaged — source, dotfiles, `.env*`, VCS data, lockfiles, `node_modules/`, and unreferenced assets are never collected.                                                                |

After installing or removing an integration, restart `app-api` so the
integration host picks up the change:
`pnpm openmapx services restart app-api`.

## `users`

Manage user accounts directly against the PostGIS database (the commands run
`psql` inside the `postgis` container, so the stack must be up). Use them to
bootstrap the first administrator before email delivery is configured.

| Command                 | Description                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| `users list`            | List registered users (id, email, name, role).                                 |
| `users promote <email>` | Promote a user to admin by email.                                              |
| `users demote <email>`  | Remove the admin role from a user.                                             |
| `users verify <email>`  | Mark a user's email as verified — unblocks sign-in when SMTP isn't set up yet. |

The user must have signed up through the web UI first; these commands update an
existing row rather than creating one.

## `backup`

Create, list, restore, prune, and delete on-disk backups of service volumes under
`infra/docker/backups/`. See
[Backup and restore](../administration/backup-and-restore.md) for what's included
and the restore prerequisites and recovery procedure.

| Command                 | Description                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backup create`         | Back up every backup-enabled service volume. Flag: `--name <name>` (default: ISO timestamp).                                                                             |
| `backup list`           | List existing backups.                                                                                                                                                   |
| `backup restore <name>` | Restore a backup. Flags: `--services <ids...>` restricts to a subset; `--stop-running` stops target services and isolates `app-api` during an OpenMapX database restore. |
| `backup prune`          | Delete backups older than the retention period. Flag: `--retention-days <days>` (defaults to `BACKUP_RETENTION_DAYS`, itself 30).                                        |
| `backup delete <name>`  | Delete a backup directory.                                                                                                                                               |

## `cache`

Inspect and clear the Redis cache. These commands run `redis-cli` inside the
`redis` container, so the stack must be running.

The current CLI does not pass the generated Redis password to `redis-cli`.
These commands therefore fail with `NOAUTH` against the managed authenticated
Valkey service. Do not disable authentication to make them work. The table below
describes their intended operations; it is not a working managed-deployment
cache maintenance procedure.

| Command                | Description                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache list`           | List cache key namespaces and their counts.                                                                                                                                                  |
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

## `transitous`

Inspect the active [Transitous](https://github.com/public-transport/transitous)
catalog pin or propose a new Transitous and MobilityData GBFS pin set.

| Command           | Description                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transitous show` | Print the current lockfile contents.                                                                                                                                                                                              |
| `transitous bump` | Fetch upstream pins, summarize changes, and write `transitous.lock.proposed.json` and `gbfs-catalog.lock.proposed.json` under `infra/docker/`. Flags: `--yes` (skip the confirmation prompt), `--branch <name>` (default `main`). |

`transitous bump` reads from a catalog clone the data-manager maintains, so run a
transit sync once (`pnpm openmapx data sync`) before the first bump. The command
does not replace the active lockfiles or switch the running graph. Review the
proposal and validate an inactive MOTIS slot before activation; restarting the
data-manager does not activate the proposal. See
[MOTIS operations profiles](../administration/motis-operations-profiles.md).

## `transit-registry`

Manage the pinned commit of the upstream `public-transport/transport-apis` catalog
used by the dynamic transit registry, recorded in `infra/docker/transport-apis.lock.json`.

| Command                 | Description                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transit-registry show` | Print the current `transport-apis.lock.json` lockfile contents.                                                                                                                                                                                                                  |
| `transit-registry bump` | Resolve and validate the upstream catalog, report the candidate, and update the lockfile, `integrations/transit-dynamic-registry/pin.ts`, and its manifest health checks. Flags: `--yes` (skip interactive prompt), `--branch <name>` (defaults to the upstream default branch). |

Review all three changed files and run `pnpm check-toolchain-pins`. Updating the
source pin does not rebuild or deploy the running API image.

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
