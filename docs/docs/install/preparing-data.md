---
title: Preparing data
description: Download source data, build regional artifacts, refresh transit datasets, and move prepared data between hosts.
sidebar_position: 5
---

# Preparing data

Complete [Getting started](./getting-started.md) before running network downloads.
The data-manager must be healthy for downloads, transit sync, and hardlink
application. Build helpers also need local Docker access.

Choose explicit service IDs and the smallest useful region. `build-all` and
`data update` build every installed buildable service, including engines that
are not enabled.

## The data-manager

The data-manager owns `infra/docker/data/`, mounted as `/data`. It downloads
source files, records dataset inventory, and applies hardlinks to consumer paths.
Transit source/job/promotion metadata lives in PostgreSQL; compiled timetable
rows live in MOTIS artifacts.

The host CLI reaches the published loopback port `http://localhost:4000`.
`DATA_MANAGER_HOST_PORT` relocates it; `DATA_MANAGER_URL` can specify an explicit
endpoint. API-to-data-manager traffic uses Docker DNS instead. Mutation endpoints
require `DATA_MANAGER_AUTH_TOKEN`, which the CLI reads from `.env` and attaches
automatically. Keep the loopback port private.

## How regions are named

OSM downloads use Geofabrik paths, such as `europe/germany` or
`north-america/us/california`. `planet` selects the worldwide source. Slashes
become hyphens on disk: `europe/germany` becomes
`infra/docker/data/osm/europe-germany.osm.pbf`.

Set `OPENMAPX_REGION` in `.env` to avoid repeating a region. Explicit arguments
win, followed by an engine-specific variable such as `OSRM_REGION`, then the
shared default. A build can use the sole PBF on disk when no region is specified;
it refuses ambiguity when several candidates exist.

Download scope does not filter every other dataset. Photon and BRouter select
their own regional downloads, and transit scope uses country codes or feed IDs.

## Downloading source data

### OpenStreetMap extracts

```bash
pnpm openmapx data download osm europe/germany
# With OPENMAPX_REGION set:
pnpm openmapx data download osm
```

A successful transfer publishes the PBF under `data/osm/`. Interrupted downloads
do not replace the previous good file. Check disk space before downloading a
larger extract; serving multiple PBFs does not automatically give each consumer
the correct region. Inspect the generated hardlink plan when several inputs exist.

### Transit schedule sources

For a configured MOTIS deployment, sync the requested country subset:

```bash
pnpm openmapx data sync --countries de,at,ch
pnpm openmapx data source list
```

Sync queues an asynchronous job. It builds a complete candidate dataset in an
inactive MOTIS slot, validates and probes it, then promotes it. The command
returning a job ID does not mean the import has completed. Track the job in the
admin activity/data workflow view and compare requested and active source state.

The lifecycle needs selected MOTIS/staging services, sufficient capacity, and
prepared configuration. Follow [Transit engines](../guides/transit-engines.md)
and [MOTIS operations profiles](../administration/motis-operations-profiles.md)
before the first sync. Do not replace an operating dataset with a manual
stop/build/start sequence for routine feed updates.

Use IDs from `data source list` to disable or re-enable catalog entries:

```bash
pnpm openmapx data source remove catalog:de:vbb
pnpm openmapx data source enable catalog:de:vbb
```

Add an operator source with its provenance and license:

```bash
pnpm openmapx data source add https://example.org/agency-gtfs.zip \
  --name "Example Transit" \
  --region de-be \
  --attribution "Example Transit" \
  --license-spdx CC-BY-4.0
```

The URL above is a placeholder; supply a real feed you may use and its actual
license. `--license-url` is available instead of an SPDX identifier. Add, remove,
and enable changes queue a new candidate; failure retains the previous live
sources. Independent backups remain useful for disaster recovery.

Operator URLs must be public HTTP(S) endpoints on default ports and contain no
credentials. Private, loopback, link-local, and reserved targets are rejected,
including after redirects or DNS resolution. Acquisition allows at most five redirects, revalidating and DNS-pinning each hop.
A feed has a 512 MiB compressed limit and a five-minute remote-download deadline.
An unused relay capability expires after ten minutes; once claimed, a ten-minute
total deadline covers download and streaming, and 30 seconds without byte
progress aborts it. Client disconnect or run termination also aborts and deletes
the private archive. The capability is single-use even after failure, and cannot
fall back to exposing the remote URL to the runner. Audit records are limited to
source kind, hostname, duration, byte count, outcome, and successful SHA-256.
Credential headers, where supported, cannot follow cross-origin redirects.
Configure authenticated catalog feeds
through the API-key file:

```bash
pnpm openmapx data generate-api-keys
# Edit services/motis/tools/transitous/api-keys.json, then:
pnpm openmapx data sync --countries de
```

Regeneration keeps existing required values and removes obsolete keys. Keep
this file private; it is mounted into data-manager and the private runner,
not distributed as ordinary source data. An optional age key is described in
`infra/docker/secrets/README.md`.

### Map glyphs

```bash
pnpm openmapx data download fonts
```

This installs OpenMapTiles glyph PBFs atomically under `data/tile-fonts/`.
`OPENMAPTILES_FONTS_URL` selects a pinned or mirrored archive. Download glyphs
for TileServer GL or local offline-package generation. Hosted-only maps do not
need this step. OpenMapX styles and sprites already ship with the web app.

## Building prepared artifacts

```bash
pnpm openmapx services build osrm --region europe/germany
# Equivalent positional-region alias:
pnpm openmapx data build osrm europe/germany
```

The build prepares files, records provenance, renders configuration, and applies
hardlinks. Stop **all** consumers before building or importing:

| Build target | Consumers that must be stopped                                | Output below `data/`               |
| ------------ | ------------------------------------------------------------- | ---------------------------------- |
| `osrm`       | `osrm`                                                        | `osrm-graph/`                      |
| `otp`        | `otp`                                                         | `otp-graph/`                       |
| `pelias`     | `pelias`, `pelias-pip`, `pelias-placeholder`, `elasticsearch` | `pelias/`                          |
| `tileserver` | `tileserver`                                                  | `tile-mbtiles/`                    |
| `motis`      | `motis`, `motis-staging`                                      | `motis/live/`, `motis-feed-proxy/` |

For example:

```bash
pnpm openmapx services stop osrm
pnpm openmapx services build osrm --region europe/germany
pnpm openmapx services start osrm
```

OSRM, OTP, Pelias, and TileServer builds stage into sibling `.next` directories
and swap only after success. Budget space for old and new artifacts together,
including both Pelias Elasticsearch indexes. OSRM skips an unchanged input/image/
profile/traffic build. Other build targets do not all share that cache behavior.

MOTIS's low-level build prepares initial/off-host data in place; `--import` also
runs the runtime import. It is distinct from transactional live transit sync.
Valhalla, Nominatim, and Overpass import within their service containers; they
have no CLI build hook.

`services build-all --region europe/germany` currently plans OSRM, OTP, MOTIS,
Pelias, and TileServer GL even when only one is selected. It continues after
individual failures unless given `--fail-fast`. Explicit `services build <ids>`
stops on the first failure unless given `--continue-on-error`. Inspect failures
before starting consumers; a successful later target does not repair an earlier
failure.

### Deriving secondary formats

Overpass needs bzip2-compressed OSM XML:

```bash
pnpm openmapx data convert overpass europe/germany
pnpm openmapx data link
```

Conversion reads the matching PBF and writes `data/osm-bz2/data.osm.bz2`.
It is a separate step, including after refreshing the PBF; `data update` does
not run this conversion. See [OSM data queries](../guides/osm-data-queries.md).

### Search index and Overture Places

The following examples use Germany; replace it with your prepared region:

```bash
pnpm openmapx data search-index build europe/germany
pnpm openmapx data search-index status
pnpm openmapx data notable-places build
pnpm openmapx data notable-places status
pnpm openmapx data overture-sync europe/germany
pnpm openmapx data overture-status
```

`overture-sync` runs the pull, ingest, and conflation sequence. Individual
`overture-pull`, `overture-ingest`, `overture-conflate`, and `overture-extract`
commands are available for troubleshooting. `overture-conflate --restart`
discards saved phases; use it only when a full restart is intended.

For global ambient maps, prepare `planet` explicitly with the same PBF for the
format 2 search index and Overture conflation before publishing Planet in the
admin panel. This is a substantial preparation workload. The
[global publication runbook](../developer/ambient-places-publication.md#planet-preparation-restart-and-deployment)
covers checkpoints, capacity, and recovery.

## Sharing data with hardlinks

`data link` renders the current selection and applies its producer/consumer plan:

```bash
pnpm openmapx data link
```

Correct existing links are kept; stale links are replaced and removed mappings
are pruned. Producer and consumer paths must be on the same filesystem. A
hardlink shares input bytes, while every derived graph or index adds storage.
Replacing a producer file does not update an existing consumer inode until links
are refreshed. Restart consumers after a completed refresh where required.

## Building on another host

Prepare artifacts on a larger machine with the same OpenMapX revision and
runtime image pins. Build records under `data/.openmapx-builds/` record inputs,
images, the selected release and, for a build the host CLI ran, the checkout's
commit. Bundles include file checksums; import verifies them and
runtime image compatibility before swapping data.

```bash
# Build host, with source data already downloaded:
pnpm openmapx services build tileserver --region europe/germany
pnpm openmapx data export tileserver tiles-germany.tar

# Serving host, after transferring the bundle:
pnpm openmapx services stop tileserver
pnpm openmapx data import tiles-germany.tar
pnpm openmapx services start tileserver
```

For direct streaming, both hosts need SSH and the remote checkout path:

```bash
pnpm --silent openmapx data export tileserver - \
  | ssh serve-host 'cd openmapx && pnpm --silent openmapx data import -'
```

Stop the target consumers before streaming. Export also refuses running
consumers on the build host. Import needs temporary space on the same filesystem
for `data/.openmapx-import/` plus old and new outputs. Run it as the serving
owner whose UID/GID match the containers. Relative paths are resolved from the
invocation directory.

| Service      | Bundled directories                | Excluded inputs        |
| ------------ | ---------------------------------- | ---------------------- |
| `tileserver` | `tile-mbtiles/`                    | None                   |
| `osrm`       | `osrm-graph/`                      | Staged PBF             |
| `otp`        | `otp-graph/`                       | PBF and ZIP inputs     |
| `pelias`     | `pelias/`, including Elasticsearch | `openstreetmap/` input |
| `motis`      | `motis/live/`, `motis-feed-proxy/` | None                   |

MOTIS export requires a build performed with `--import`, tying its import output
to the runtime image. Stop both MOTIS slots on each host:

```bash
pnpm openmapx services build motis --region europe/germany --import
pnpm openmapx data export motis motis-germany.tar
```

Valhalla, Nominatim, and Overpass have no supported artifact-bundle workflow.
If import reports that the artifact was installed but linking failed, fix the
reported cause and run `data link` before starting its consumers.

## Checking what you have

```bash
pnpm openmapx data status
pnpm openmapx data status --offline
```

The default view reads data-manager inventory. `--offline` scans local storage
without the daemon; filesystem presence does not establish engine readiness.
For transit desired versus active state, also use `data source list`.

## A full refresh in one command

```bash
pnpm openmapx data update europe/germany --countries de --fail-fast
```

This downloads OSM, queues a transit sync, downloads glyphs, builds all installed
prepared-artifact targets, renders, and links. The transit job is asynchronous;
this command is not a wait-for-promotion operation. It does not stop or restart
consumers, filter builds to selected engines, or convert Overpass input. It can
fail if any planned consumer is running, including MOTIS while the queued sync
is active. Prefer the targeted procedures above for routine operating updates.

## Cleaning up

:::danger[Cleanup deletes local files immediately]
`data clean` has no confirmation or dry-run flag and does not stop consumers.
`data clean all` recursively deletes **the entire `infra/docker/data/` tree**,
including operational state and journals, not just reproducible downloads.
Do not use it as routine disk maintenance on an operating instance.
:::

After stopping affected consumers and verifying backups, remove a specific
reproducible data type if needed:

```bash
pnpm openmapx data clean fonts
```

Type cleanup removes matching producer and consumer paths and prunes dataset
inventory. Re-download, re-link, and verify consumers before returning them to
service. Inspect [backup and restore](../administration/backup-and-restore.md)
before deleting anything you cannot regenerate.

## Where to go next

Use [Requirements](./requirements.md) for capacity planning and the individual
[routing](../guides/routing-engines.md), [geocoding](../guides/geocoders.md),
[transit](../guides/transit-engines.md), and [tile](../guides/map-tiles.md) guides
for readiness checks.
