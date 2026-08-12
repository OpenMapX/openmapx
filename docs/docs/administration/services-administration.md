---
title: Services administration
description: Manage backend services from the admin panel — status, config, logs, the generated compose preview, and the data inventory.
sidebar_position: 2
---

# Services administration

Everything you can do to a backend service from the command line, you can also
do from the admin panel — in a browser, behind the same login. The admin pages
under `/admin/services` are a window onto the service registry: they list what's
installed, show each service's manifest and live container status, let you edit
config and stream logs, preview the compose file the renderer would write, and
take stock of the data on disk. Under the hood these are the same operations the
CLI exposes, so reach for whichever surface fits the moment.

If you haven't met the service model yet, start with
[How it works](../overview/how-it-works.md): a *service* is a backend daemon
described by a `service.json` manifest, *capabilities* tie services to the
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

## The service catalog

`/admin/services` is the catalog. It lists every service the registry has
discovered — first-party services shipped in the repo and any community services
you've installed — in one table:

| Column   | What it shows                                                    |
| -------- | ---------------------------------------------------------------- |
| Service  | The display name and its manifest `id`                           |
| Version  | The manifest version                                             |
| Quality  | A badge: **Built-in**, **Verified** (community-verified), or **Community** |
| Provides | The capabilities the service offers (`routing-engine`, `geocoder`, …) |
| Status   | The container's Docker state — running, exited, restarting, not running |

A summary across the top counts the total, running, and stopped services, and
you can narrow the list with the search box (by name, id, or capability) and the
quality-tier filter. Click a service name to open its detail page.

### Service selection

The catalog also surfaces the **selection** — the set of root services that
participate in your deployment. The selection panel shows the requested roots,
the effective count after the renderer expands dependencies, and where the
selection is coming from. You can edit the comma-separated list of root ids and
**Save Selection** to persist it.

When the selection is being driven by the `OPENMAPX_ENABLED_SERVICES` environment
variable, the panel says so and disables editing — the environment variable wins,
and the UI keeps that unambiguous rather than letting you save a file that won't
be read. Saving the selection changes what *will* be rendered and started; it
doesn't touch running containers until you start or update them.

### Bulk actions

Tick the checkboxes beside one or more services and the bulk-action bar lets you
**Start**, **Stop**, **Restart**, **Update**, or **Build** the selection in one
go, plus **Build All** and a **Run Service Check** that refreshes container
states. Builds take an optional region and a "continue on errors" toggle. Each
action is queued as a background job — the toast names the job id, and the
**View Jobs** link opens the activity view where the job's log streams.

## A single service in detail

`/admin/services/<id>` is the per-service page. A header shows the name, quality
badge, live container status, and whether the service is in the current
selection, alongside the action buttons. Below that, four tabs:

### Overview

A read-only digest of the manifest: id, version, author, license, platform,
homepage, and the directory it was loaded from, plus its description and the
capability and data wiring that make it swappable —

- **Provides** — the capabilities this service offers to integrations.
- **Consumes** — the shared data it mounts (an OSM extract, a prepared graph,
  map glyphs), with the mount path and whether it's read-only or optional.
- **Environment variables** — the env vars the manifest declares, each marked
  required or optional, with its description and default.
- **Exposure** — how, if at all, the service is reachable from outside the
  private Docker network: any host-port bindings and the reverse-proxy path
  prefix. By default a service is reachable only by other containers; see
  [Managing services](../install/managing-services.md) for what exposure means
  in practice.

### Config

If the manifest declares a `configSchema`, this tab renders it as a form — one
field per operator-tunable setting, typed from the schema (toggles for booleans,
dropdowns for enums, text and number inputs otherwise). Services without a
schema show a note instead; those are configured through environment variables or
bind-mounted config files.

Each field carries a **source** chip telling you where its current value comes
from, following the three-layer cascade that resolves at render time:

| Source     | Meaning                                                            |
| ---------- | ----------------------------------------------------------------- |
| `default`  | The schema's default — nothing has overridden it.                 |
| `database` | A value you saved here, stored in the database.                   |
| `env`      | A host environment variable (`SERVICE_<ID>_<KEY>`) is dictating it. |

Environment variables always win, so any field driven by one is shown **disabled**
— you can see the effective value but can't edit it from the UI, because the host
environment would override your edit anyway. The form header repeats the env-var
prefix so the override convention is discoverable. Two buttons commit changes:

- **Save** persists the edited fields to the database. The new value takes effect
  on the next render and container restart — saving alone doesn't restart
  anything.
- **Save & Apply** saves and then immediately queues an apply so the
  change is picked up without a manual step. Service config lands in the
  generated compose environment, so applying a new value goes through a compose
  re-render under the hood.

For the broader story of where settings live — the `.env` file, secrets, and how
the panel relates to environment variables — see
[Configuration](../install/configuration.md).

### Logs

Opening the Logs tab (or the **Logs** button) slides out a drawer that streams
the service's container logs live, tailing the most recent lines. It's the same
output as the equivalent `services logs` CLI command, in the browser — handy for
watching a build finish or diagnosing a service that won't come up.

### Manifest

The full `service.json`, pretty-printed. This is the raw source of truth behind
the Overview tab — useful when you're verifying exactly what a community service
declares before trusting it.

### Lifecycle actions

The header buttons drive the container, each queued through the job runner:

- **Start / Apply changes** — the primary button. It re-renders from the current
  manifests and config and brings the container up, so it picks up changes. The
  label reads **Apply changes** when the service is already running and **Start** when
  it isn't.
- **Stop** — stops the container.
- **Restart** — an *in-place* reboot. It does not re-render, so it won't pick up a
  changed manifest, `.env`, or config — use it to bounce a service whose image
  and config are unchanged.

The distinction between Start/Apply changes and Restart matters: if you've just changed
config or the manifest, use Apply changes, not Restart. The same nuance applies
on the CLI and is spelled out in
[Managing services](../install/managing-services.md). Every lifecycle and config
action is rate-limited and recorded in the audit log.

## Compose preview

`/admin/services/compose` renders the `docker-compose` YAML the renderer *would*
write for your currently enabled services, regenerated on each request. It
follows the same selection and config resolution as the CLI render, so it's a
faithful preview — a good last look before you bring the stack up, especially
after changing the selection or a service's config.

The page also offers **Compose Up** and **Compose Down** buttons that render,
apply the data hardlink plan, and start or stop the whole enabled stack. There's
no compose file to hand-edit anywhere — it's generated, every time. To re-render
from the CLI, run `pnpm openmapx compose render`.

## Data inventory

`/admin/services/data` is the inventory and control surface for the open data the
stack runs on. It pulls together the active engine data and the operational
metadata tracked by the data-manager:

- **OSM planet data** — whether an OSM extract is present, its filename, region,
  size, and download date.
- **Service build inventory** — a read-only grid showing which engines have
  populated their data directories (Valhalla, OSRM, OTP, MOTIS, Pelias, the tile
  server, and so on) and when they were built.
- **Transit sources** — one lifecycle row per catalog or operator source. The
  row shows its origin, desired and active state, archive format/size,
  validation result, last fetch and promotion times, and available actions.
  Desired and active state can differ while a job is running or after a failed
  candidate: the prior healthy MOTIS dataset stays live until the complete
  candidate passes validation and promotion.

Catalog sources can be disabled and later re-enabled. An operator source is
defined by a region, a safe display name, its HTTPS URL, attribution text, and
either an SPDX license identifier or license URL. Adding, disabling, enabling,
or manually syncing a source queues an asynchronous job; the row links to the
activity log and disables conflicting actions while that job is active.

MOTIS is the only compiled static-schedule runtime. Postgres stores the
data-manager's source, job, validation, manifest, and promotion metadata; it
does not contain imported GTFS schedules.

A **Data Operations** panel queues the same data jobs the CLI runs — downloading
OSM and map glyphs, transactional transit sync, the full update pipeline, the
Overpass conversion, hardlink sync, cleanup, and the Transitous API-key
template. Each queues a background job whose log you can follow in the activity
view. The destructive cleanup operation asks for confirmation first. The full
data workflow is documented in [Preparing data](../install/preparing-data.md).

### OSM code and alias search index

The data workflow also operates the local OSM code/alias/acronym index used by
consumer autocomplete. It shows the source region and fingerprint, current
build stage, place and term counts, publication epoch and time, whether a newer
PBF has made the index stale, and the last error. Building is explicit: select
the downloaded region and confirm the operation, or run
`openmapx data search-index build [region]`. A new PBF never triggers a
country- or planet-scale rebuild during API boot.

The job requires PostGIS and Osmium Tool. It streams records in bounded batches
into `osm_search__staging`, builds exact/prefix and geographic indexes, validates
counts and referential integrity, then swaps schemas in one database
transaction. Extraction, validation, or publication failure keeps the prior
snapshot live. During a rebuild the existing snapshot remains searchable;
after a new PBF the stale snapshot also remains available until replaced.

Plan temporary disk for the source PBF, staging tables and indexes, and the
previous live schema during publication. The feature initially supports one
active extract or `planet`, not overlapping regional unions. All derived rows
remain isolated in `osm_search` and retain OpenStreetMap's ODbL attribution;
they are never mixed into the independently licensed Overture schema.

## Related admin surfaces

A few service-adjacent pages sit alongside this one:

- **[Backups](./backup-and-restore.md)** (`/admin/services/backups`) — list,
  create, restore, and delete the on-disk snapshots under
  `infra/docker/backups/`. Backups with a missing or malformed manifest are still
  listed and flagged as corrupt, with restore disabled but delete available so
  you can clean them up.
- **[Community extensions](./community-extensions.md)** (`/admin/extensions`) —
  browse, install, update, and remove third-party extensions (integrations,
  services, and bundles of both) from the unified Extensions store. Installing a
  bundle's service adds it to the catalog you operate from this page.

For configuring the *features* that run on top of these services — the geocoding
and routing orchestrators, transit providers, overlays, and external data
sources — see [Integrations & bindings](./integrations-administration.md). For
health snapshots and the running job log, see [Monitoring](./monitoring.md).

## Where to go next

- **[Managing services](../install/managing-services.md)** — the full CLI
  reference for everything on this page, plus selection files, presets, builds,
  and exposure.
- **[Preparing data](../install/preparing-data.md)** — downloading OSM, GTFS, and
  styles, and the build/link pipeline behind the data inventory.
- **[Configuration](../install/configuration.md)** — the `.env` file, secrets,
  and how the admin config forms relate to environment variables.
