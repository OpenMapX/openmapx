---
title: Services administration
description: Select services, apply configuration, inspect logs and operate data workflows from the admin panel.
sidebar_position: 2
---

# Services administration

Manage supported backend service operations from the admin panel in a browser,
behind the same login. Operation availability follows the current instance and
service ownership; initial installation and offline recovery require host access. The admin pages
under `/admin/services` are a window onto the service registry: they list what's
installed, show each service's manifest and live container status, let you edit
config and stream logs, preview the compose file the renderer would write, and
take stock of the data on disk. Under the hood these are the same operations the
CLI exposes, so reach for whichever surface fits the moment.

If you haven't met the service model yet, start with
[How it works](../overview/how-it-works.md): a _service_ is a backend daemon
described by a `service.json` manifest, _capabilities_ tie services to the
integrations that need them, and the compose renderer turns your enabled
manifests into a running stack. This page assumes that picture and focuses on the
web UI.

:::note[Two surfaces, one behavior]
The admin panel and the `openmapx` CLI act on the same registry and produce the
same effects. The full command reference — selection files, presets, rendering,
builds, exposure — lives in
[Managing services](../install/managing-services.md). When this page says "the
equivalent CLI command," that's where to find it.
:::

The API submits typed operations to the operations agent, which owns Docker
access, registry credentials, community repositories and generated host
configuration. A full administrator account and an available agent are required
for these web operations.

## The service catalog

The catalog lists discovered built-in and community services, their manifest
version, quality tier, capabilities and container state. Search by name, ID or
capability, then open a service to inspect its configuration and logs.

| Column   | What it shows                                                              |
| -------- | -------------------------------------------------------------------------- |
| Service  | The display name and its manifest `id`                                     |
| Version  | The manifest version                                                       |
| Quality  | A badge: **Built-in**, **Verified** (community-verified), or **Community** |
| Provides | The capabilities the service offers (`routing-engine`, `geocoder`, …)      |
| Status   | The container's Docker state — running, exited, restarting, not running    |

A summary across the top counts the total, running, and stopped services, and
you can narrow the list with the search box (by name, id, or capability) and the
quality-tier, enabled-state and exact-capability filters. The capability vocabulary panel lists custom or unrecognized entries and their owning services; namespaced vendor capabilities are allowed. Click a service name to open its detail page.

Container state is not a functional health check. Use **Run Service Check** or
[Monitoring](./monitoring.md) when a running container does not serve requests.

### Service selection

The selection contains the requested root services and their expanded
dependencies. It is shared with `openmapx services selected` and the CLI's
`services enable` workflow.

1. Inspect the selection source and current roots.
2. Enter the required root IDs and choose **Save Selection**.
3. Review **Compose preview**, then start or update the affected services.

Saving publishes a generated configuration; it does not start or stop containers.
The selection file is `infra/docker/state/ops-agent/service-selection.json`.
A nonempty `OPENMAPX_ENABLED_SERVICES` override takes precedence and disables
editing. Empty, whitespace-only or comma-only overrides are treated as unset.

Requested selection, the published host configuration generation and running
containers can differ. Check all three after a failed apply instead of assuming
that an error restored the previous state.

### Action presets and root controls

Choose an **action preset** to select the same root group as the CLI `--preset`
option. Presets show missing installed members and never save selection by themselves.
The server expands and validates preset roots; normal action restrictions still apply.

Each row identifies an enabled root, a required dependency, or a disabled service.
**Enable** adds only that service to the existing roots; **Remove root** removes only
its explicit root entry. It may remain enabled when another root requires it. Required
dependencies cannot be removed independently, and host-controlled selections stay
locked. Selection writes use the same reviewed generation producer as the root editor.

### Bulk actions

Tick the checkboxes beside one or more services and the bulk-action bar lets you
**Start**, **Stop**, **Restart**, **Update**, or **Build** the selection in one
go, plus **Build All** and a **Run Service Check** that refreshes container
states. Updates offer **without dependency recreation**, corresponding to `--no-deps`.
Builds take an optional region, a "continue on errors" toggle, and MOTIS-only import
(`--import`) for a selected MOTIS build or Build All with enabled, buildable MOTIS.
Other actions cannot carry these options. Whole-stack starts explicitly name the
frozen generated service closure so release-overlay entries cannot create disabled
services. Each
action is queued as a background job — the toast names the job id, and the
**View Jobs** link opens the activity view where the job's log streams.

Acceptance alone does not establish completion; follow the original job until
it reaches a terminal state.

**Stage selected images** downloads immutable image content without rendering,
retagging, starting, or recreating services. It resolves the configured image for
the host's platform; release-managed services use the exact selected release pin.
Configured tags and running-container ownership stay unchanged. In local release
mode, floating references are resolved to manifest digests. An unavailable or
ambiguous platform manifest fails before downloading. Follow the retained job in
Activity; retrying its confirmation after a connection failure observes the same
request. Apply an update separately when you want services to use newer images.

## A single service in detail

Open `/admin/services/<id>`. Its header shows container state, selection and
lifecycle actions. The detail page has **Overview**, **Configuration**, **Credentials**,
**Logs** and **Manifest** tabs.

### Overview

Review the service ID, version, author, licence, platform and source directory.
The page also shows:

| Field                 | Operator use                                           |
| --------------------- | ------------------------------------------------------ |
| Provides              | Capabilities available for integration bindings        |
| Consumes              | Shared data mounts, including optional/read-only state |
| Environment variables | Declared variables and defaults                        |
| Exposure              | Host-port bindings and declared proxy routes           |

Community services receive a separate network and no platform proxy route.
Host-port publication still creates exposure: inspect its effective bind address
and protocol in the extension preview.

### Config

Open the **Configuration** tab. A manifest's `configSchema` supplies the form. Services without one use their
documented environment or mounted configuration.

| Source     | Priority                               |
| ---------- | -------------------------------------- |
| `env`      | Highest; `SERVICE_<ID>_<KEY>` override |
| `database` | Value saved in the administration form |
| `default`  | Manifest default                       |

Environment-driven fields are disabled. Use the exact variable name shown in the
form; hyphens become underscores and names are upper-cased.

- **Save** validates and stores the patch, then publishes a full trusted host
  configuration generation. It does not recreate the container.
- **Save & apply** performs the save, then queues a service start/apply job to
  recreate the container with the generated configuration.

A host CLI render preserves settings and service secrets from the last published
configuration generation, then applies the host environment. It cannot read a
new database edit that failed before publication. If a save reports a conflict,
unknown outcome or cleanup failure, inspect current configuration and job state
before retrying. See [Configuration](../install/configuration.md).

### Credentials

Set declared secret fields here, with `OPENMAPX_SECRETS_KEY` configured for the
API vault. Values are encrypted in the database and rendered as private files;
containers receive `<KEY>_FILE=/run/secrets/<KEY>`. The API returns status and
masked values instead of the credential body.

A credential change queues an apply when host control is available. Follow that
job. A `needsRender` response requires host render/apply work; storing the
credential alone does not prove the container received it.

### Logs

Opening the Logs tab (or the **Logs** button) shows the service's container
output. Choose the last **100, 200, 500, or 1000 lines**, then use **Snapshot**
for a completed read or **Follow** for live output. Follow duration ranges from
30 seconds to 15 minutes. Pause stops the current reader; Resume and Reconnect
start a fresh read with the selected options. Closing the drawer stops its reader.

The browser retains at most **1000 lines and 256 KiB**, including an incomplete
line, and reports when earlier output is discarded. Snapshot output also has a
server byte limit. Credential redaction applies to both modes. A reader reaching
its duration or ending does not mean the service failed; reconnect to read more.

Container logs can include upstream diagnostics or personal data. Review and
redact them before sharing.

### Manifest

Inspect the full `service.json` before changing configuration or trusting a
community service. The manifest declares intended behavior, not a security audit
of the container's executable code.

### Lifecycle actions

| Action                | Effect                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| Start / Apply changes | Render current configuration, apply hardlinks and bring the service up |
| Stop                  | Stop the service container                                             |
| Restart               | Restart in place with the existing container configuration             |

Use **Apply changes** after changing configuration, manifests or environment.
A restart does not recreate the container. Administrative host operations have
safety restrictions; use **Maintenance** for the coordinated core-release update
rather than trying to update the running API as an ordinary service job.

## Compose preview

Open `/admin/services/compose` to inspect the generated Compose YAML for the
current selection and resolved configuration. Do not edit generated files.
Use the form or source configuration, then render again.

**Generate configuration** commits the preview's checked revision and applies its
prepared hardlinks without starting or restarting containers. An empty plan needs
no Data Manager; a nonempty plan requires an already-running Data Manager. If it
stops after generation commits, Activity retains the committed revision and
reports the failed or unresolved link work. Container application remains pending.
A stale preview is refused; refresh before confirming another generation.

**Compose Up** prepares the full selected generation and starts only that explicit
closure. It preserves existing Data Manager and operations-agent containers with
`--no-recreate`, then applies ordinary services with `--no-deps`. Apply or update
Data Manager from its service page. Use Settings or System Maintenance to replace
the agent through the guarded helper. Up does not silently replace either
protected container or start services mentioned only by a release overlay.

Full shutdown stops the panel and its agent, so the page shows a copyable host
command instead of a nonfunctional stop button:

```bash
pnpm openmapx compose down
```

Volumes remain intact. Destructive volume removal and recovery while the agent is
unavailable are host procedures; see [Managing services](../install/managing-services.md).
There is no generated Compose file to hand-edit. The host render command remains
`pnpm openmapx compose render`.

## Platform ownership

Applied configuration generations retain a versioned, non-secret ownership
projection for the instance domain, ACME contact email, release selector, default
region and backup retention. Unadopted fields continue to use their host variables.
An explicit database-owned value survives later CLI rendering; a CLI `--domain`
argument affects that invocation and keeps the saved ownership intact. Returning
a field to host ownership removes its saved value. Service and integration
configuration keep their existing environment and file precedence.

The default region never expands the operations agent's deployment allow-list.
A default outside `OPENMAPX_ALLOWED_REGIONS` is refused; explicit operation
regions remain subject to the same deployment policy. This projection contains
no platform credentials or arbitrary environment keys.

## Data inventory

Open `/admin/services/data` to inspect OSM downloads, engine build directories,
transit source state and specialized publication workflows. Follow the linked
jobs for failures and progress. Operation forms, previews and risk levels come
from the API's operation catalog.

For a transit source:

Catalog and operator sources can be disabled and later re-enabled. Disable
retains the saved URL, attribution and license. The separate, confirmed Remove
action is available only for operator sources and deletes their saved metadata;
enabling cannot restore a removed source. Catalog entries can be disabled but
cannot be removed from their pinned catalog. An operator source is
defined by a region, a safe display name, its HTTPS URL, attribution text, and
either an SPDX license identifier or license URL. Adding, disabling, enabling,
or manually syncing a source queues an asynchronous job; the row links to the
activity log and disables conflicting actions while that job is active.

Source search and pagination run on the server, so entries beyond the first
500 remain reachable. Optional discovery enriches installed catalog entries
without replacing their IDs or licensing; discovery-only entries populate the
Add form for review rather than pretending they are already enabled.

**Sync sources** and **Run sync now** open a country review. Select a subset of
the instance's allowed countries, then preview its source count, conservative
size estimate, capacity blockers and warnings. The preview expires after five
minutes and is checked again before admission and worker execution. Browser
supplied capacity values cannot authorize a sync. Slot limits come from the
instance configuration; an unavailable measurement blocks the preview.
Queuing reports an Activity job, not a completed import. A retry of an already
accepted intent observes its original job even if the preview cache was lost.

MOTIS is the only compiled static-schedule runtime. Postgres stores the
data-manager's source, job, validation, manifest, and promotion metadata; it
does not contain imported GTFS schedules.

A failed candidate preserves the prior healthy dataset. Confirm active source
publication after completion; saved desired changes do not establish it. See
[MOTIS operations profiles](./motis-operations-profiles.md).

Other operations include OSM/glyph acquisition, full update, Overpass conversion,
hardlink sync, cleanup, Transitous key-template generation and Overture full
sync/resume. Destructive cleanup requires confirmation. See
[Preparing data](../install/preparing-data.md).

### OSM code and alias search index

Choose a downloaded region and build explicitly, or run:

```bash
pnpm openmapx data search-index build [region]
```

The job requires PostGIS and Osmium Tool. It streams into staging, builds
indexes, validates and publishes in one database transaction. Failure preserves
the prior snapshot; a newer PBF marks that snapshot stale without triggering a
large rebuild during API boot.

Inspect stage, counts, publication epoch/time and last error. A ready code/alias
index does not prove ordinary business-name/address coverage. For investigation,
record `sourceFingerprint` and `epoch` from the authenticated
`/api/data-manager/search-index/status`, plus Overture's release and region.
The summary card does not show the fingerprint. See
[Business-name/address retrieval](../developer/business-name-address-retrieval.md).

Plan disk for the PBF, staging tables/indexes and prior live schema. One active
extract or `planet` is supported, without overlapping regional unions. Derived
OSM rows stay in `osm_search` with ODbL attribution, separate from Overture.

### Nearby places publication

The **Nearby places on the map** card publishes existing OSM/Overture sources
for a custom region, Germany or the planet. Inspect active generation and source
coverage separately from staged progress. A preset does not ingest missing data.

Planet builds require a ready format-2 `planet` OSM snapshot and, when Overture
is initialized, a matching completed Overture snapshot. Interrupted candidates
can be resumed only with unchanged sources and policy, or discarded. Disable
and rollback preserve retained immutable tiles. Follow the
[publication runbook](../developer/ambient-places-publication.md) for capacity
and recovery.

### Notable places index

Inspect the Wikidata place/name counts, sitelink threshold, publication time and
last error. Data Manager builds a missing index on startup and refreshes monthly.
Choose **Rebuild now**, or run:

```bash
pnpm openmapx data notable-places build
```

The job queries SPARQL, stages and validates the result, then swaps the
`notable_places` schema transactionally. A failed refresh preserves the prior
index. Runtime depends on the endpoint and dataset; no fixed completion time is
guaranteed. See [Notable places configuration](../install/configuration.md#notable-places-for-search).

## Related admin surfaces

Use [Backups](./backup-and-restore.md) for recovery snapshots and
[Extensions](./community-extensions.md) for installing or removing community
components. Configure the features using those services under
[Integrations & bindings](./integrations-administration.md).

## Where to go next

- **[Managing services](../install/managing-services.md)** — the full CLI
  reference for everything on this page, plus selection files, presets, builds,
  and exposure.
- **[Preparing data](../install/preparing-data.md)** — downloading OSM, GTFS, and
  styles, and the build/link pipeline behind the data inventory.
- **[Configuration](../install/configuration.md)** — the `.env` file, secrets,
  and how the admin config forms relate to environment variables.

## Transit feed credentials

Use **Transit → Transit feed credentials** to manage the encrypted
`data-manager/TRANSITOUS_API_KEYS` map. The panel displays key names and whether
values are configured, required by the active catalog, or retained as orphaned
entries. It never returns existing values. A blank input preserves the existing
value; deletion is a separate confirmed action.

Review changes before confirming a fresh administrator sign-in. The review is
bound to the current catalog pins, credential revision and configuration. If any
changes, prepare a new review. The complete operation saves the map and updates
the running Data Manager's credential mount under one maintenance reservation.
A pending-application warning means the running mount has not been verified; use
Activity to inspect the original operation. A retry observes the retained work
rather than applying it twice. Finish or cancel an administrator's unresolved
instance operations before deleting their account; those operations retain the
private inputs needed for recovery.

File and environment overrides remain host-owned. The panel explains that
ownership and does not silently adopt their values. The host-local
`openmapx data generate-api-keys` command creates or updates a template from the
active pins while preserving all existing values and orphaned keys. The previous
browser generator operation is no longer available.

## Operator settings and resource limits

Every built-in service has a Config tab with optional memory (16–1048576 MiB)
and CPU (0.125–256 cores) limits. These are Docker `deploy.resources.limits`,
not environment variables. Leaving a field unset preserves the manifest limit,
including host interpolation. Clear a saved resource field to restore that limit. Host-owned fields are locked; both `SERVICE_*`
overrides and the original variable referenced by a manifest take precedence.
Saving uses the same validated, sealed prospective configuration as applying:
failed database reads, invalid values or an oversized snapshot refuse the entire
change. Saving configuration does not rebuild prepared data.

MOTIS resource settings belong to **primary MOTIS**. The same generation gives
both primary and staging slots identical limits and updates the data-manager's
capacity projection. The staging fields are read-only. Apply the coordinated
stack, then rerun transit preflight before another build: profile minimums,
candidate/rollback headroom, CPU, disk and timeout checks still apply. Reserving
resources for only the active slot is insufficient.

| Service                               | Editable settings                                                                                                                                                                                                                                                                                                                                                       | Actual consumer                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| All 30 built-ins                      | `OPENMAPX_MEMORY_MIB`, `OPENMAPX_CPU_LIMIT` (staging MOTIS follows primary)                                                                                                                                                                                                                                                                                             | Docker Compose resource limits; never container environment                                                                     |
| app-api                               | `LOG_LEVEL`; `RATE_LIMIT_IMAGE_PROXY_MAX_BYTES`, `RATE_LIMIT_IMAGE_PROXY_WINDOW_MS`, `RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_PER_CLIENT`, `RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_GLOBAL`                                                                                                                                                                                 | Pino logger and image-proxy request/byte/concurrency budget                                                                     |
| app-web                               | `NEXT_PUBLIC_STYLE_PROVIDER`, `NEXT_PUBLIC_MAP_STYLE_URL`, `NEXT_PUBLIC_TILES_URL`, `NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE`, `NEXT_PUBLIC_CYCLOSM_TILE_URL_TEMPLATE`, `NEXT_PUBLIC_TERRAIN_DEM_TILEJSON_URL`, `NEXT_PUBLIC_TERRAIN_CONTOUR_TILEJSON_URL`, `NEXT_PUBLIC_TERRAIN_ATTRIBUTION_NAME`, `NEXT_PUBLIC_TERRAIN_ATTRIBUTION_URL`, `NEXT_PUBLIC_TRAFFIC_MIN_ZOOM` | Server runtime projection into the browser; map glyphs/basemap, raster tiles, terrain, attribution and raster traffic zoom gate |
| data-manager                          | `LOG_LEVEL`, `OVERTURE_DUCKDB_MEMORY_MB`, `OVERTURE_DUCKDB_THREADS`, `OVERTURE_DUCKDB_TEMP_MB`                                                                                                                                                                                                                                                                          | Logger and bounded DuckDB memory/thread/spill settings                                                                          |
| local-ai                              | `OLLAMA_KEEP_ALIVE` (0 or duration up to 24h), `OLLAMA_MAX_LOADED_MODELS`                                                                                                                                                                                                                                                                                               | Ollama's model lifetime and loaded-model count                                                                                  |
| elasticsearch                         | `OPENMAPX_JAVA_HEAP_MIB`                                                                                                                                                                                                                                                                                                                                                | Only `-Xms<N>m -Xmx<N>m` in `ES_JAVA_OPTS`; choose heap below the container limit                                               |
| nominatim                             | `THREADS`, `REPLICATION_UPDATE_INTERVAL`, `IMPORT_STYLE`, `REVERSE_ONLY`, `IMPORT_WIKIPEDIA`, `IMPORT_US_POSTCODES`, `IMPORT_GB_POSTCODES`                                                                                                                                                                                                                              | Image import and replication environment; import settings require a database rebuild                                            |
| photon                                | `REGION`, `UPDATE_STRATEGY` (PARALLEL/SEQUENTIAL), `UPDATE_INTERVAL` (1h–8760h), `LOG_LEVEL` (DEBUG/INFO/WARN/ERROR)                                                                                                                                                                                                                                                    | Photon image index acquisition, update scheduling and Python logger; TRACE is unsupported                                       |
| overpass                              | `OVERPASS_SPACE`, `OVERPASS_FASTCGI_PROCESSES`, `OVERPASS_UPDATE_SLEEP`, `OVERPASS_RULES_LOAD`                                                                                                                                                                                                                                                                          | Image query memory, workers, refresh and rules budget                                                                           |
| postgis                               | `POSTGIS_DIAGNOSTICS`, `POSTGIS_TRACK_IO_TIMING`                                                                                                                                                                                                                                                                                                                        | OpenMapX's PostgreSQL entrypoint diagnostics                                                                                    |
| valhalla                              | `serve_tiles`, `build_time_zones`, `use_tiles_ignore_pbf`, plus existing `build_elevation` and `build_admins`                                                                                                                                                                                                                                                           | Scripted image environment, serialized as `True`/`False`                                                                        |
| Existing BRouter and Dawarich schemas | Existing routing/import/thread and application/database/credential fields                                                                                                                                                                                                                                                                                               | Existing service consumers and typed credential workflows, preserved alongside resource fields                                  |

The legacy `NEXT_PUBLIC_MAP_STYLE_URL` name denotes the **glyph server base**,
not a style JSON document. URL fields accept an absolute HTTP(S) URL without
credentials or a same-origin path beginning with one `/`. Empty means default.
Protocol-relative URLs, backslashes, controls and unsupported placeholders are
refused. Only tile-template fields accept `{z}`, `{x}`, `{y}` and `{s}`.
Local paths such as `/local-dem/tiles.json`, `/local-contours/tiles.json` and
`/tiles` remain supported. Runtime values are read by the server for each page
request; they are not frozen into the Docker image during `next build`.

Raster traffic's optional minimum zoom is an integer from 0 through 24. Unset
or malformed host values retain its manifest default of 10. Both the raster
layer and the layer selector use the same threshold; the separate vector
traffic-flow integration keeps its default of 6.

Free-form JVM flags, Node flags and shell preprocessing commands are not editable
through these forms. Community manifests cannot declare the platform's reserved
resource fields to expand their resource authority.

Consumer references: [Ollama environment parser](https://github.com/ollama/ollama/blob/v0.40.3/envconfig/config.go),
[Photon 2.4.0 settings](https://github.com/rtuszik/photon-docker/blob/2.4.0/src/utils/config.py)
and [logger](https://github.com/rtuszik/photon-docker/blob/2.4.0/src/utils/logger.py),
[Nominatim import styles](https://nominatim.org/release-docs/latest/customize/Import-Styles/),
and [Valhalla scripted image](https://github.com/valhalla/valhalla/blob/master/docker/README.md).

Platform-wide settings use the reviewed [Platform configuration](./platform-configuration.md) workflow.
