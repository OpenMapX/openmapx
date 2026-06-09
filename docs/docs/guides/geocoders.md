---
title: Self-hosting geocoders
description: Choose and self-host a geocoder — Photon, Nominatim, or Pelias — and point the geocoding integration at it.
sidebar_position: 2
---

# Self-hosting geocoders

A **geocoder** turns text into coordinates and coordinates back into addresses —
it's the engine behind the search bar and the names that appear on dropped pins.
OpenMapX never talks to a geocoder directly. Search requests go to the
**geocoding** integration, which orchestrates an ordered chain of provider
integrations, and each of those wraps one engine. This guide covers the three
engines you can self-host from a `service.json` manifest: **Photon**,
**Nominatim**, and **Pelias**.

If you only want to understand how search behaves in the app, read
[Search & autocomplete](../features/search.md) first. This page is about
standing the engines up. For how services and integrations fit together at all,
see [How it works](../overview/how-it-works.md).

:::note[You usually run one]
Photon, Nominatim, and Pelias overlap in purpose — all three geocode
OpenStreetMap. Running more than one mostly multiplies RAM and disk for little
gain. Pick the one that matches your needs; the rest of this page helps you
choose. (Mixing a self-hosted engine with a hosted fallback like MapTiler is a
different, sensible pattern — that's the fallback chain, not three full engines.)
:::

## Choosing an engine

The three engines trade simplicity, completeness, and resource cost differently.

| | **Photon** | **Nominatim** | **Pelias** |
| --- | --- | --- | --- |
| Best at | Search-as-you-type | Completeness, reverse, enrichment | Composite/modular geocoding |
| Setup | Lowest — one container | Low — one container | High — five containers |
| Getting data | Auto-downloads a prebuilt index | Imports OSM on first boot | Multi-step build pipeline |
| Build step | None | None (self-imports) | `openmapx services build pelias` |
| RAM ceiling (manifest) | 8 GB | 64 GB (import peak) | ~4 GB (Elasticsearch) |
| Disk (planet) | ~200 GB | ~330 GB | ~100 GB |
| Reverse geocoding | Yes | Yes (also powers enrichment) | Yes |
| Updates | Re-downloads the index periodically | Built-in OSM replication | Re-import |
| Public fallback | Komoot's instance | The OSM instance | None — must self-host |

A few rules of thumb:

- **Photon is the lightest path to good search.** It skips the import entirely by
  downloading a prebuilt worldwide index, and its API is built for
  search-as-you-type, so autocomplete feels instant. The cost is steady-state
  RAM (~8 GB) and ~200 GB of disk for the planet index.
- **Nominatim is the most complete.** It's the geocoder behind OpenStreetMap
  itself, with structured search, Wikipedia-based importance ranking, and strong
  reverse geocoding — which is why several other features (place enrichment, the
  shared-mobility station resolver) lean on it. The cost is a heavy first import:
  its manifest reserves a 64 GB ceiling for the import peak, though steady-state
  runtime use is far lower.
- **Pelias is the modular choice.** It combines OpenStreetMap (addresses, venues,
  streets) with Who's On First (administrative boundaries) behind Elasticsearch,
  and has a dedicated autocomplete endpoint. The cost is operational: it's five
  cooperating containers and a multi-step build.

The RAM ceilings and disk figures above come straight from the service manifests
and the sizing tables in [Requirements](../install/requirements.md) — read that
page before you commit to a region, because region size drives almost everything
downstream.

Every engine below is enabled, rendered, started, and configured with the same
`openmapx` CLI verbs described in [Managing services](../install/managing-services.md),
and feeds on data prepared as in [Preparing data](../install/preparing-data.md).
The commands here assume the always-on core (PostGIS, Redis, the data-manager,
the app) is already up.

## Pointing the app at your geocoder

Whichever engine you run, the wiring into the app is the same two steps, and you
do both from the admin panel (see [Configuration](../install/configuration.md)
for how admin settings relate to environment variables):

1. **Enable the matching provider integration.** Each engine has a companion
   `geocoding-*` integration that adapts its API to OpenMapX's uniform result
   shape: `geocoding-photon`, `geocoding-nominatim`, `geocoding-pelias`.
2. **Put the provider in the chain.** The `geocoding` integration takes a
   comma-separated **provider order** (config key `provider`) — the fallback
   chain tried left to right. The default is `maptiler`; set it to your engine,
   for example `photon` or `photon,maptiler`.

Each provider integration also has an `endpoint` config value. When you run the
self-hosted service, you can leave it blank: the orchestrator resolves the
endpoint from the running service automatically (via the `geocoder` capability).
Set it explicitly only to point at an instance elsewhere, or to override the
public default. Resolution order, highest priority first, is the
`INTEGRATION_GEOCODING_<NAME>_ENDPOINT` env var, then the admin setting, then the
running service, then a built-in default (Komoot for Photon, the OSM instance for
Nominatim, none for Pelias).

Every upstream call is proxied through your own API server, so the geocoder only
ever sees your server's address, not your users'.

## Photon

Photon is the simplest engine to stand up: it consumes no source data from the
data-manager and has no build step. On first start it downloads a prebuilt
search index — derived from Nominatim data, complete with importance rankings —
and begins serving.

**Enable and start:**

```bash
pnpm openmapx services enable photon
pnpm openmapx services start photon
```

On first boot the container downloads the worldwide index (~200 GB) into its
bind-mounted data directory (`data/photon/`) and stays in Docker's `starting`
state until it's ready. The download time is bandwidth-bound — tens of minutes
on a fast link, longer on a slow one. Watch it:

```bash
pnpm openmapx services logs photon --follow
```

Subsequent restarts come up in seconds from the cached index.

**Scope and cost.** By default Photon pulls the full planet index regardless of
region. To download a smaller country index instead, set `PHOTON_REGION` (a
country code) in `infra/docker/.env`, then re-render and recreate:

```bash
# infra/docker/.env
PHOTON_REGION=germany
```

```bash
pnpm openmapx compose render
pnpm openmapx services recreate photon
```

Runtime cost is roughly 8 GB RAM (the manifest's ceiling) and the index's disk
footprint; see the Photon row in [Requirements](../install/requirements.md).
The index is refreshed automatically on a long interval (`UPDATE_INTERVAL`,
720h/30 days by default) using the `PARALLEL` strategy — it downloads the new
index alongside the old one and swaps with zero downtime, so it stays current
without intervention. The catch is disk: a `PARALLEL` refresh briefly needs room
for two copies of the index, so size the volume for roughly double the planet
footprint if you let updates run unattended.

**Wire it up.** Enable the `geocoding-photon` integration and put `photon` in the
provider order. Leave the integration's endpoint blank and it resolves to your
running service; with no service, it falls back to Komoot's public instance.

## Nominatim

Nominatim bundles its own PostgreSQL and imports an OpenStreetMap extract on
first start — there's no separate build command, but the import is the heaviest
single step of any geocoder here.

**Get the data, then start.** Nominatim *consumes* an `osm-pbf`, so download the
extract and link it into place before starting:

```bash
pnpm openmapx data download osm europe/germany   # or "planet" for worldwide
pnpm openmapx services enable nominatim
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start nominatim
```

The link step hardlinks `data/osm/<region>.osm.pbf` to the file the container
expects (`data.osm.pbf` under its data mount). On first boot Nominatim imports
that extract into its internal database — minutes for a city, hours for a
country, far longer for a planet. The container's health check allows a long
start period for exactly this reason; follow the logs to watch progress:

```bash
pnpm openmapx services logs nominatim --follow
```

**Scope and cost.** The manifest reserves a **64 GB** memory ceiling — that's the
import peak, not steady-state. Region imports need far less; a single country is
comfortable on a modest host. See the Nominatim row in
[Requirements](../install/requirements.md), which also notes its ~330 GB
planet database. A few import knobs live in `infra/docker/.env`:

```bash
# infra/docker/.env
NOMINATIM_THREADS=8                 # import parallelism
NOMINATIM_IMPORT_WIKIPEDIA=true     # importance ranking from Wikipedia
```

The manifest also exposes `IMPORT_STYLE` (`full` by default; lighter styles like
`address` or `street` trade coverage for a smaller, faster import) and
`REVERSE_ONLY`. Nominatim keeps itself current through built-in OpenStreetMap
replication, so once imported it tracks daily diffs on its own.

**Wire it up.** Enable `geocoding-nominatim` and put `nominatim` in the provider
order. A blank endpoint resolves to your service, falling back to the public OSM
instance. Because Nominatim also powers reverse geocoding and place enrichment
elsewhere in the stack, it's a strong default when you want one engine to do
everything.

## Pelias

Pelias is a composite geocoder: a query API in front of Elasticsearch, fed by
both OpenStreetMap (addresses, venues, streets) and Who's On First
(administrative boundaries). It's the most capable on structured and
autocomplete queries, and the most operationally involved — it runs as **four
services**: `pelias` (the API), `elasticsearch`, `pelias-placeholder`, and
`pelias-pip`. The `pelias` preset bundles them.

Unlike Photon and Nominatim, Pelias has no public fallback instance — there's
nothing to point at unless you build and run it yourself.

**Get the data and build the index.** Download the OSM extract, then run the
Pelias build, which stages the PBF, downloads Who's On First, imports both into a
temporary Elasticsearch node, and builds the Placeholder database:

```bash
pnpm openmapx data download osm europe/germany   # or "planet"
pnpm openmapx services enable pelias
pnpm openmapx services build pelias --region europe/germany
```

The build writes its prepared data under `data/pelias/` (the OSM PBF, Who's On
First bundles, and the Placeholder SQLite store). It runs in an isolated,
temporary compose project and tears that down when finished — so the build must
not run while the runtime Pelias services are up. If they are, stop them first.

:::caution[Stop the consumers before rebuilding]
The build resets the shared Elasticsearch index and stages new files into the
directories the runtime containers read. It refuses to run while `pelias`,
`pelias-placeholder`, or `pelias-pip` are up — stop them, build, then start
again. See [Preparing data](../install/preparing-data.md) for why builds and
live consumers don't mix.
:::

**Render, link, and start the runtime services:**

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start --preset pelias
```

The link step wires the Placeholder and PIP services to the data the build
produced; `data link` is what connects each consumer to its producer directory.
Elasticsearch must come up healthy before the API will serve — its manifest
declares that dependency, so the renderer orders startup for you.

**Scope and cost.** Steady-state RAM is dominated by Elasticsearch (~4 GB at the
manifest ceiling), with the API, Placeholder, and PIP adding less; planet disk is
around 100 GB. See the Elasticsearch (Pelias backend) row in
[Requirements](../install/requirements.md). Pelias has no incremental update path
— to refresh, re-run the build against a newer extract.

**Wire it up.** Enable `geocoding-pelias` and put `pelias` in the provider order.
Set the integration's endpoint to your running Pelias API (there's no public
default to fall back on).

:::tip[Elasticsearch needs a kernel setting]
Elasticsearch refuses to start unless the host's `vm.max_map_count` is at least
`262144`. Set it on the Docker host with
`sudo sysctl -w vm.max_map_count=262144` (persist it in `/etc/sysctl.conf`).
:::

## Verifying

Once an engine is running, confirm the chain answers from it by searching in the
app — the attribution shown beneath suggestions records which provider replied.
You can also check container health directly:

```bash
pnpm openmapx services status photon       # or nominatim, or the pelias preset
pnpm openmapx check                        # one-shot status across the stack
```

To rule the orchestrator out and confirm the engine itself is serving, query its
host port directly. Each engine's port is the one its `service.json` binds to
`127.0.0.1` — so these only work from the Docker host, not the network. Pick the
block for the engine you're running:

```bash
# Nominatim (host port 8088). /status reports the import timestamp;
# a search confirms the index answers.
curl -fs http://localhost:8088/status
curl -s 'http://localhost:8088/search?q=Berlin&format=jsonv2' | jq '.[0].display_name'
```

```bash
# Photon (host port 2322). This is also its container health probe.
curl -s 'http://localhost:2322/api?q=Berlin' | jq '.features[0].properties.name'
```

```bash
# Pelias — note the API is on host port 4300 (container 4000). Check the
# backend first: Elasticsearch must be green/yellow before the API will serve.
curl -s http://localhost:9200/_cluster/health | jq '.status'
curl -s 'http://localhost:4300/v1/search?text=Berlin&size=1' | jq '.features[0].properties.label'
curl -fs http://localhost:4100/demo                 # Placeholder (coarse geocoding)
curl -fs http://localhost:4200/-/health             # PIP (admin point-in-polygon)
```

An empty Nominatim `/search` or a Pelias result with no `features` means the
import or build hasn't populated the index yet — tail the logs and wait for it to
finish. A red Elasticsearch `status` means it never came up healthy; check
`vm.max_map_count` and disk space first (see the Pelias notes above).

## Switching

Switching engines later is just editing the provider order and enabling the
other integration — no data migration. And search degrades gracefully: with no
geocoder configured at all, the map, coordinate input, and Plus Codes still work;
you simply lose name and address suggestions until a provider is back in the
chain.

## Where to go next

- **[Search & autocomplete](../features/search.md)** — how the provider chain,
  caching, and result shaping behave in the app.
- **[Requirements](../install/requirements.md)** — the RAM and disk each engine
  needs, by region scale.
- **[Managing services](../install/managing-services.md)** — the full vocabulary
  of `enable`, `render`, `start`, `build`, and `configure`.
- **[Preparing data](../install/preparing-data.md)** — downloading OSM extracts
  and the build/link pipeline these engines feed on.
- **[Service manifests](../developer/service-manifest.md)** — the schema behind
  every `service.json` referenced here.
