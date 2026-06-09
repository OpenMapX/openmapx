---
title: Self-hosting transit (MOTIS & OTP)
description: Run your own transit routing engine — MOTIS for planet-scale coverage or OpenTripPlanner for a single region.
sidebar_position: 3
---

# Self-hosting transit engines

Public-transit journey planning in OpenMapX is answered by a chain of providers,
and at the top of that chain sits a transit *engine* you run yourself. This guide
covers the two OpenMapX ships with — **MOTIS** and **OpenTripPlanner (OTP)** —
from picking one, through downloading and preparing the data they need, to
pointing the transit integration at the running container.

If you just want to understand what transit does for a rider, read
[Public transit](../features/public-transit.md) first; this page is about the
operator side. The general service lifecycle (enable, render, start) lives in
[Managing services](../install/managing-services.md), and the data commands in
[Preparing data](../install/preparing-data.md) — this guide assumes you've met
both and focuses on the transit-specific parts.

## MOTIS or OTP?

Both engines build a transit graph from an OpenStreetMap extract plus GTFS feeds
and answer journey, stop, and departure queries. They differ sharply in the scale
they handle.

| | **MOTIS** | **OpenTripPlanner** |
| --- | --- | --- |
| Coverage | A single country up to the **whole planet** | A **single region** — country or smaller |
| GTFS feeds | Hundreds | Roughly **ten** before the graph stops fitting in memory |
| Planet extract | Supported | Refused by the build (see below) |
| Schedule import | At container **startup** (re-importable in place) | At **build** time, baked into `graph.obj` |
| API | MOTIS v2 REST (Transitous-compatible) | REST v1 + GraphQL v2 |
| Integration | `transit-motis` (`transit-motis-local`, priority 1) | `transit-otp` |

**MOTIS is the primary engine** and the recommended choice for almost every
deployment. It's the top of the transit chain (`transit-motis-local`), scales
from one country to the planet on a single server, and re-imports feeds on
startup rather than forcing a graph rebuild. OTP is here for the narrower case
where you want a single-region router with a GraphQL API or OTP-specific routing
features, and you have only a handful of feeds. If you're unsure, choose MOTIS.

Both engines are memory-hungry; how hungry depends entirely on how big a region
you build. See [Requirements](../install/requirements.md) for the RAM and disk
sizing before you commit to a region — region size drives almost every cost
downstream.

:::tip[Pick the smallest region that covers your users]
A single country is modest; a continent is several times larger; the planet is an
order of magnitude more on every axis (download, build, RAM, disk). OTP can't
build a planet graph at all — its build step refuses anything over ~50 GB and
fails immediately on `planet.osm.pbf`. For worldwide transit, use MOTIS.
:::

## Self-hosting MOTIS

### 1. Enable the service

MOTIS is opt-in. Add it to the selection and it pulls in its companion services
automatically — the renderer expands `motis` to include the `motis-feed-proxy`
it depends on:

```bash
pnpm openmapx services enable motis
```

The `transit` preset bundles the engines together if you'd rather enable them as
a unit:

```bash
pnpm openmapx services start --preset transit   # motis, motis-feed-proxy, otp
```

### 2. Get the source data

MOTIS reads an OSM extract (for the walking and cycling legs between stops) and
the GTFS feeds it routes on. Download both for your region:

```bash
# OSM extract — Geofabrik path naming, or `planet` for the whole world
pnpm openmapx data download osm europe/germany

# GTFS feeds, resolved from the Transitous catalog and filtered by country
pnpm openmapx data download gtfs --countries de,at,ch
```

The OSM step is optional for MOTIS but recommended — without it, MOTIS still
plans transit but can't draw street-level walking legs to and from stops. The
GTFS step is covered in more detail under [Adding feeds](#adding-gtfs-feeds)
below; for now, `--countries` filters the community
[Transitous](https://github.com/public-transport/transitous) catalog to the
countries you name. Downloaded feeds land in `data/gtfs/` as `.zip` archives.

### 3. Build the prepared data

MOTIS's build step doesn't compile MOTIS — it assembles the exact input
directory the container imports on startup. It stages the OSM PBF and GTFS feeds,
runs the Transitous toolchain to generate the engine's `config.yml` and an
attribution `license.json`, and renders the feed-proxy configuration:

```bash
pnpm openmapx services build motis --region europe/germany
# equivalent data-namespace alias:
pnpm openmapx data build motis europe/germany
```

`--region` selects which downloaded OSM extract to build against; with
`MOTIS_REGION` (or the general `OPENMAPX_REGION`) set in `infra/docker/.env` you
can omit it. The prepared directory is written to **`data/motis/live`** — the
plain bind mount the running container reads from.

:::caution[Stop the engine before rebuilding]
The build stages files into the directory a running container reads. Stop MOTIS
first so it never sees a half-swapped state:

```bash
pnpm openmapx services stop motis
pnpm openmapx services build motis --region europe/germany
pnpm openmapx services start motis
```

Builds skip their work when the input is unchanged, so re-running is cheap.
:::

### 4. Render, link, and start

After a build, wire the prepared data into the stack and bring the engine up:

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start motis
```

`services start` actually re-renders and re-links for you, so in practice the
build → start sequence is enough. MOTIS imports its feeds on first boot, which
takes anywhere from a few minutes for one country to a couple of hours at planet
scale. Watch it happen:

```bash
pnpm openmapx services logs motis --follow
```

Subsequent restarts are fast — MOTIS detects unchanged inputs and skips the
re-import. The container runs as `${UID}:${GID}` (defaulting to `1000:1000`) so
the files it writes back stay owned by the host operator. It listens on
`8080` inside the Docker network and is published to the host on loopback
`127.0.0.1:8081` for local debugging.

### Adding GTFS feeds

There are two ways feeds reach MOTIS.

**From the Transitous catalog (the default).** `data download gtfs` resolves the
feed list from the community-curated catalog at request time and filters it by
`--countries`. New feeds that Transitous adds upstream are picked up on the next
run. Some catalog sources need API keys; generate a template, fill in the values
you have, then download:

```bash
pnpm openmapx data generate-api-keys
# edit services/motis/tools/transitous/api-keys.json
pnpm openmapx data download gtfs --countries de
```

**Your own feeds.** To pull in a private operator URL or a one-off feed the
catalog doesn't carry, add it directly. The slug defaults to the basename of the
URL:

```bash
pnpm openmapx data add-feed https://example.org/agency-gtfs.zip
pnpm openmapx data remove-feed agency-gtfs
```

You can also supply an entire pinned feed list instead of the catalog with
`--feeds-file ./feeds.json` (a JSON array of `{ id, country, url }` entries — see
[Preparing data](../install/preparing-data.md#gtfs-transit-feeds)).

Either way, a feed change means re-staging and re-importing. Rebuild the prepared
data and restart:

```bash
pnpm openmapx data download gtfs --countries de   # or add-feed / remove-feed
pnpm openmapx services stop motis
pnpm openmapx services build motis --region europe/germany
pnpm openmapx services start motis
```

### Keeping feeds fresh: the staging pipeline

You don't have to rebuild MOTIS by hand to stay current. OpenMapX's data-manager
runs a daily **Transitous pipeline** that re-fetches feeds, builds them against a
**separate staging MOTIS instance** (`motis-staging`, a sibling container reading
`data/motis/staging`), validates the result with smoke queries, and only then
**atomically swaps** the fresh data into the live engine and restarts it. If a
feed turns up corrupt or an upstream is down, the partial run is abandoned and
your running engine is never touched.

`motis-staging` is opt-in — it only needs to exist while a sync runs, and the
primary `motis` container is the only one that ever serves application traffic.
Enable it alongside MOTIS when you want the automated refresh:

```bash
pnpm openmapx services enable motis-staging
```

The pipeline, its lockfile-pinned Transitous ref, and the cron schedule live in
the data-manager service; for everyday operation, just leaving `motis-staging`
enabled gives you a hands-off daily update with a built-in rollback.

## Self-hosting OpenTripPlanner

OTP is the region-scale alternative. Its workflow mirrors MOTIS with one key
difference: OTP imports GTFS **at build time** into a serialized `graph.obj`, so
every feed change is a full rebuild rather than a restart.

### 1. Enable and get data

```bash
pnpm openmapx services enable otp

pnpm openmapx data download osm europe/germany     # required for OTP
pnpm openmapx data download gtfs --countries de
```

OSM is **mandatory** for OTP — it builds the street network the transit graph is
linked onto. Keep the feed count modest: OTP combines everything into one
in-memory graph, and more than ~10 sizeable feeds risks build failures or
runaway memory.

### 2. Build the graph

```bash
pnpm openmapx services build otp --region europe/germany
# or: pnpm openmapx data build otp europe/germany
```

This runs OTP's `--build --save` over your OSM extract and GTFS feeds and writes
`graph.obj` into **`data/otp-graph/`**. The build refuses planet-scale input —
point it at `planet.osm.pbf` (or anything over ~50 GB) and it errors out before
starting. The build defaults to a generous `-Xmx24g` JVM heap; bump it for large
regions or trim it for a single city.

### 3. Link and serve

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start otp
```

The runtime container starts with `--load --serve`, loading the pre-built graph
rather than rebuilding. It listens on `8080` inside the network, published to the
host on `127.0.0.1:8090`. OTP's build (`services/otp/config/build-config.json`)
and routing (`services/otp/config/router-config.json`) parameters are
bind-mounted from the service directory — edit them there and rebuild or restart
to apply.

After any feed or OSM change, OTP needs the full cycle again:

```bash
pnpm openmapx data download gtfs --countries de
pnpm openmapx services build otp --region europe/germany
pnpm openmapx services start otp
```

## Pointing the transit integration at your engine

Running the engine is a *service* decision; whether the transit orchestrator
*uses* it is an *integration* decision. The two engines map to two integrations,
each resolving its endpoint through the standard config cascade.

**MOTIS** is wired through the `transit-motis` integration (and, for stop search,
`geocoding-motis`). When the `motis` service is in your selection, both resolve
its address through the service registry automatically — no configuration needed.
A deployment-wide override is available if you ever need it:

```bash
# infra/docker/.env — only needed to override the registry default
MOTIS_URL=http://motis:8080
```

Inside Docker, containers reach the engine at `http://motis:8080`; the
`MOTIS_URL` env var and the per-integration `endpoint` config key (under
`/admin/integrations/transit-motis`) are manual overrides that win over the
registry when set.

**OTP** is wired through the `transit-otp` integration. Its endpoint resolves in
the same way — service registry when `otp` is enabled, then the admin-panel
`endpoint` value, then `INTEGRATION_TRANSIT_OTP_ENDPOINT`, falling back to
`http://localhost:8090` for local development.

Which providers participate, and any credentials they need, is managed per
integration at `/admin/integrations`, with anything set in `infra/docker/.env`
winning over the admin-stored value. See [Public transit](../features/public-transit.md#configuring-transit)
for the full picture of the provider chain that sits on top of your engine, and
[the service-manifest reference](../developer/service-manifest.md) for the
manifest fields (`consumes`, `bindMounts`, `exposure`) referenced above.

## Verifying it works

A quick reachability check against the host-published port:

```bash
# MOTIS — health endpoint
curl -s http://localhost:8081/api/v1/health

# OTP — router metadata (200 = a graph is loaded)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/otp/routers/default
```

Then plan a real journey from the OpenMapX UI: open the directions panel, switch
to the transit tab, and check the itineraries come from your instance. If results
are empty, the usual culprits are an import still in progress (watch the logs), a
query outside your feeds' coverage area, or — for walking legs — OSM data that
wasn't linked.

## See also

- [Preparing data](../install/preparing-data.md) — the download/build/link
  pipeline these engines plug into.
- [Managing services](../install/managing-services.md) — enabling, rendering,
  starting, and configuring any service.
- [Requirements](../install/requirements.md) — RAM and disk sizing by region.
- [Public transit](../features/public-transit.md) — the rider-facing feature and
  the full provider chain.
- [Self-hosting routing engines](./routing-engines.md) — OSRM and Valhalla, the
  driving/walking/cycling counterparts to the transit engines.
