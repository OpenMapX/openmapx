---
title: Preparing data
description: How OpenMapX downloads and prepares OSM extracts, GTFS transit feeds, tile data, and map glyphs with the data-manager service and CLI.
sidebar_position: 5
---

# Preparing data

OpenMapX's backend engines don't ship with data — they build their indexes from
open sources you provide. A routing engine needs an OpenStreetMap extract, a
transit engine needs GTFS feeds, and a self-hosted tile server needs vector data
and glyphs. This page covers how OpenMapX obtains that data and shapes it into the
form each engine expects.

All of it runs through one service, the **data-manager**, and one CLI namespace,
`openmapx data`. If you've already read [How it works](../overview/how-it-works.md),
this is the part where "OpenMapX runs on open data" becomes a set of concrete
commands.

## The data-manager

The data-manager is a small built-in service that owns the shared data tree at
`infra/docker/data/` (mounted as `/data` inside the container). It does three
things:

- **Downloads** source data — OSM extracts from Geofabrik, transactional transit
  sources from Transitous or operator URLs, and map glyph fonts —
  over the network. Partial transfers never replace good files.
- **Tracks** ordinary downloaded artifacts in its state file and transit source,
  job, validation, manifest, and promotion metadata in Postgres. Postgres does
  not contain GTFS schedule rows.
- **Hardlinks** files into place so that every consumer service sees its own copy
  of the input data while the bytes live on disk exactly once.

That last point is the reason a single OSM extract can feed routing, tiles, and
geocoding without being copied three times. More on it under
[Sharing data with hardlinks](#sharing-data-with-hardlinks).

The data-manager is part of the always-on core, so once your stack is up it's
already running. In a typical deployment it listens only on the internal Docker
network; the CLI reaches it at `http://localhost:4000` by default (override with
`DATA_MANAGER_URL`). Every command below talks to it on your behalf — you rarely
call its HTTP API directly.

:::note[Authentication]
The data-manager's download and link endpoints require the
`DATA_MANAGER_AUTH_TOKEN` shared secret. The CLI attaches it automatically from
the environment, so as long as the same token is set in your shell and on the
service (both read it from `infra/docker/.env`), the commands below just work.
:::

## How regions are named

Most data is downloaded and built per region. OpenMapX uses Geofabrik's path
naming directly: a region is a slash-separated path like `europe/germany`,
`north-america/us/california`, or the special value `planet` for the whole world.

- `openmapx data download osm europe/germany` fetches
  `https://download.geofabrik.de/europe/germany-latest.osm.pbf`.
- On disk the slashes become hyphens: `europe/germany` is stored as
  `data/osm/europe-germany.osm.pbf`, and `planet` as `data/osm/planet.osm.pbf`.

You can avoid repeating the region on every command by setting `OPENMAPX_REGION`
in `infra/docker/.env`; the download and build commands fall back to it when you
omit the argument. (Individual engines also honor service-specific overrides such
as `OSRM_REGION` or `MOTIS_REGION` when you want one engine built for a different
area.)

:::tip[Pick the smallest region that covers you]
Region size drives almost everything downstream — download time, build time, RAM,
and disk. A single country is modest; a continent is several times larger; the
planet is an order of magnitude more. The [Requirements](./requirements.md) page
breaks down the sizing. Region-scale engines like OSRM and OTP can't handle a
planet extract at all — use Valhalla and MOTIS for worldwide coverage.
:::

## Downloading source data

The `openmapx data download` command pulls each kind of raw source data. Run it
after the core stack (including the data-manager) is up.

### OpenStreetMap extracts

```bash
pnpm openmapx data download osm europe/germany
# or, with OPENMAPX_REGION set in .env:
pnpm openmapx data download osm
```

This downloads the region's `.osm.pbf` from Geofabrik into `data/osm/`. It's the
foundational dataset: routing engines, the tile builder, and the geocoders all
read from it. Use `planet` for the full world (a large, slow download — plan disk
accordingly).

### Transit schedule sources

MOTIS is the only compiled static-schedule runtime. A sync builds the complete
requested source set in an inactive MOTIS slot, validates it, probes its static
capabilities, and promotes it atomically. The requested and active source sets
can therefore differ while a job runs or when a candidate fails; failure keeps
the previous live dataset untouched.

```bash
# Sync the pinned catalog subset for these countries
pnpm openmapx data sync --countries de,at,ch

# Inspect requested, active, and lifecycle state
pnpm openmapx data source list
```

The catalog is the pinned community-curated
[Transitous](https://github.com/public-transport/transitous) source. A catalog
entry can be disabled and later re-enabled:

```bash
pnpm openmapx data source remove catalog:de:vbb
pnpm openmapx data source enable catalog:de:vbb
```

Add a private or one-off operator source by declaring all provenance fields. The
name must be a safe display name and the license must be identified by SPDX id
or URL:

```bash
pnpm openmapx data source add https://example.org/agency-gtfs.zip \
  --name "Example Transit" \
  --region de-be \
  --attribution "Example Transit" \
  --license-spdx CC-BY-4.0
```

Add, remove, enable, and sync commands queue asynchronous jobs. Use the returned
job id in the admin activity view. The source list shows when desired and active
state differ. Backing up before a routine update is optional because promotion
retains the prior healthy MOTIS slot for automatic rollback; use the separate
backup workflow when your operating policy requires an independent copy.

Operator feed URLs stay in the data-manager's protected desired-state store.
During a sync, upstream Transitous receives only an unguessable, one-use relay
URL bound to that run; it never receives the remote URL, query string, or
credential headers. The relay accepts public HTTP(S) endpoints on their default
ports, follows at most five redirects, revalidates and DNS-pins every hop, and
rejects a hop if any resolved address is private, loopback, link-local, or
reserved. A feed is limited to 512 MiB of compressed bytes and a five-minute
remote-download deadline. An unused relay capability expires after ten minutes.
Once claimed, one ten-minute total deadline covers download and response
streaming, and a client that makes no byte progress for 30 seconds is
disconnected. Run termination and client disconnects also abort the stream and
delete the private archive. A failed use cannot be retried or fall back to the
remote URL. Audit records contain only the source kind, hostname, duration,
byte count, outcome, and successful SHA-256 digest.

Do not embed credentials in an operator URL. Authenticated catalog feeds keep
using the API-key file below. If an operator source is extended with configured
headers, redirects must retain the exact scheme, hostname, and effective port;
credentials are never forwarded cross-origin.

:::note[Authenticated Transitous feeds]
Some Transitous sources require API keys. Generate a key template, fill in the
values you have, then sync:

```bash
pnpm openmapx data generate-api-keys
# edit services/motis/tools/transitous/api-keys.json
pnpm openmapx data sync
```

Existing values are preserved on regeneration; keys no longer required by the
current catalog are dropped.
:::

### Map glyphs

```bash
pnpm openmapx data download fonts
```

This atomically installs the OpenMapTiles glyph PBF tree in `data/tile-fonts/`.
Set `OPENMAPTILES_FONTS_URL` to use a pinned or internally mirrored archive.
The OpenMapX light/dark styles and sprites already ship in the web app; the data
pipeline does not download or rewrite a duplicate style bundle. Online
self-hosting and offline packages reuse those same web assets and only source
glyph PBFs from `data/tile-fonts/`.

You need the glyph tree when running TileServer GL or generating offline map
packages from the self-hosted OpenMapX dataset. Hosted-only deployments can
skip it.

## Building prepared artifacts

Downloading is only half the story for the heavy engines. A routing engine can't
read a raw `.osm.pbf` directly — it needs a precompiled graph. A self-hosted tile
server needs the extract baked into an MBTiles archive. These **prepared
artifacts** are produced by a separate build step that runs the engine's own
tooling (in a Docker helper image) over the data you downloaded.

Builds are per service. Each engine that needs preparation declares a build in its
manifest, and you trigger it with `openmapx services build`:

```bash
# Build one or more engines' artifacts for a region
pnpm openmapx services build osrm motis --region europe/germany

# Build every buildable engine in the current selection, in order
pnpm openmapx services build-all --region europe/germany
```

The `data` namespace offers a thin alias for the same thing, handy when you're
thinking in terms of data rather than services:

```bash
pnpm openmapx data build motis europe/germany
```

The build kinds that prepare artifacts are:

| Kind | Engine | Output |
| ---- | ------ | ------ |
| `osrm` | OSRM | Routing graph (`data/osrm-graph/`) — region scale only |
| `otp` | OTP | Transit graph (`data/otp-graph/`) — region scale only |
| `motis` | MOTIS | Prepared inputs for the MOTIS slot lifecycle |
| `pelias` | Pelias | Geocoding index (Elasticsearch + supporting data) |
| `tiles` | TileServer GL | MBTiles archive (`data/tile-mbtiles/`) from the OSM extract |

Engines that read raw source data directly — Valhalla, Nominatim, Overpass — have
no build step here; they consume the downloaded extract as-is (Overpass needs a
one-time format conversion, covered [below](#deriving-secondary-formats)).

:::caution[Stop the consumer before rebuilding]
A build stages new files into the directory the running engine reads from. To
avoid leaving a live container reading a half-swapped state, the build refuses to
run while the consuming service is up — stop it first
(`pnpm openmapx services stop <id>`), build, then start it again. Builds skip
their work entirely when the input data is unchanged, so re-running is cheap.
:::

### Deriving secondary formats

Overpass wants its OSM input as bzip2 rather than PBF. Convert a downloaded extract
in place:

```bash
pnpm openmapx data convert overpass europe/germany
```

This produces the bz2 variant in `data/osm-bz2/` from the matching PBF, in
parallel across CPU cores.

### Search index and Overture Places

The CLI provides dedicated commands for managing regional search indexes and
Overture Maps POI datasets:

```bash
# Build or check status of the local search index
pnpm openmapx data search-index build [region]
pnpm openmapx data search-index status

# Regional Overture Places synchronization and conflation
pnpm openmapx data overture-sync [region]     # end-to-end pull, ingest, and conflation
pnpm openmapx data overture-pull [region]     # pull Parquet partitions from STAC catalog
pnpm openmapx data overture-ingest [region]   # ingest raw Places into database staging
pnpm openmapx data overture-conflate [region] # rebuild OSM <-> Overture GERS entity links
pnpm openmapx data overture-status            # inspect active and staging Overture snapshots
pnpm openmapx data overture-extract           # extract regional boundaries from OSM PBF
```

## Sharing data with hardlinks

Several services consume the same files. Rather than copy a multi-gigabyte extract
into each one's directory, OpenMapX uses **hardlinks**: every consumer gets its own
path that points at the same bytes on disk.

When you run `openmapx compose render`, alongside the generated compose file it
writes a *hardlink plan* — one entry per `consumes`/`produces` match across your
enabled services. Apply that plan so each consumer's input directory points at the
producer's data:

```bash
pnpm openmapx data link
```

This re-renders the plan from your current service selection first (so it never
links directories you no longer want), then applies it: existing correct links are
left alone, stale ones are replaced, and dropped ones are pruned. It reports how
many links it created, skipped, and pruned. The links are filesystem-level — no
copying, no Docker volume juggling, and the data exists exactly once regardless of
how many services read it.

You run `data link` after any change that affects what consumes what: after a fresh
download or build, or after changing your enabled services. The all-in-one
[update](#a-full-refresh-in-one-command) command does it for you at the end.

## Checking what you have

Inspect the downloaded inventory at any time:

```bash
# Query the data-manager for the dataset inventory it tracks
pnpm openmapx data status

# Or scan infra/docker/data directly, without the data-manager running
pnpm openmapx data status --offline
```

The default view lists each dataset's type, id, size, and download time as recorded
by the data-manager. The `--offline` scan walks the data directory on disk instead —
useful before the stack is up, or to see exactly what's on the filesystem (OSM PBFs,
transit artifacts, and per-directory usage).

## A full refresh in one command

For a from-scratch or routine refresh, `data update` runs the whole sequence —
download, build, render, link — in order:

```bash
pnpm openmapx data update europe/germany
```

This downloads the OSM extract, transactionally syncs transit sources, downloads
map glyphs, builds every buildable engine's artifacts, re-renders the compose plan,
and applies the hardlinks. It's
the convenient front door once you know which region you want; the individual
commands above are there for when you want to refresh just one piece.

## Cleaning up

To reclaim space, remove the local data for a given type (or everything):

```bash
pnpm openmapx data clean osm
pnpm openmapx data clean fonts
pnpm openmapx data clean all
```

Cleanup also prunes the matching entries from the data-manager's state file. Most
downloads and build outputs are reproducible — you can always re-fetch and rebuild
— so cleaning is safe as long as you're prepared to download again.

## Where to go next

- **[Requirements](./requirements.md)** — how region size and engine choice drive
  the RAM and disk you'll need before you start downloading.
- **[How it works](../overview/how-it-works.md)** — the service/integration model
  and how the data-manager fits into a running deployment.
