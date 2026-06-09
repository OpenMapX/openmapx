---
title: Self-hosting OSM queries (Overpass)
description: Run your own Overpass API to answer live OpenStreetMap tag and feature queries — and power POI search and the recreation overlays — without leaning on the public servers.
sidebar_position: 4
---

# Self-hosting OSM data queries

Some features in OpenMapX don't want a precomputed routing graph or a rendered
tile — they want to ask OpenStreetMap a question. *Where are the bike shops in
this bounding box? Which trails pass through here? What sea marks are near this
coast?* The engine that answers those questions is **Overpass**, a read-only
query API over the live OSM database. This guide covers what Overpass does for
OpenMapX, how to run your own instead of hitting the public servers, and the
one-time data step it needs.

If you haven't yet, read [How it works](../overview/how-it-works.md) for the
service-and-integration model and [Managing services](../install/managing-services.md)
for the CLI commands this page builds on.

## What Overpass is

Overpass answers queries written in Overpass QL against a full copy of the OSM
database. Unlike a tile server (which renders the map) or a routing engine
(which precomputes a graph), Overpass keeps the raw tagged geometry — every node,
way, and relation with its tags — and serves arbitrary feature queries against
it on demand. Ask it for `amenity=bicycle_parking` in a box, or every
`route=hiking` relation in a region, and it streams back the matching elements.

OpenMapX talks to an Overpass endpoint over HTTP. By default that endpoint is the
public `overpass-api.de` server (with the Kumi Systems mirror as a fallback). The
public servers are convenient and need no setup, but they are shared,
rate-limited, and occasionally slow or down. Running your own removes the rate
limit, keeps queries on your own infrastructure, and makes the recreation
overlays and OSM-backed POI search fast and dependable.

:::note[You don't have to self-host this]
Overpass is one of the heavier services to run (see [Resource cost](#resource-cost)).
Everything it powers works against the public Overpass servers out of the box, so
self-hosting is an optimization, not a requirement. Reach for it when the public
servers' rate limits start to bite, or when you want a fully self-contained
deployment.
:::

## What it powers

When the `overpass` service is enabled, OpenMapX points its OSM queries at your
instance automatically — the integrations below switch from the public endpoint
to `http://overpass:80` on the internal Docker network with no extra
configuration. When it isn't enabled, those same integrations fall back to the
public Overpass servers, so the features keep working either way.

| Feature | Integration | What it queries OSM for |
| ------- | ----------- | ----------------------- |
| POI / category search | `poi-overpass` | Places by category and tag — the OSM-backed half of [Search](../features/search.md) |
| Transit POIs | `transit-overpass` | Stops and stations near a point |
| Cycling overlay | `overlay-cycling` | Cycle tracks, lanes, parking, and bike shops |
| Hiking overlay | `overlay-hiking` | Trail-route geometry and mountain shelters |
| Nautical overlay | `overlay-nautical` | Sea marks and related coastal features |

The map overlays appear in the layer picker, described under
[Map layers & overlays](../features/map-layers.md). Each of these features depends
on *some* Overpass endpoint being reachable; enabling the `overpass` service makes
that endpoint your own.

## Enabling Overpass

Overpass is a [service](../developer/service-manifest.md), so it follows the same
enable → render → start flow as every other backend. Add it to your selection:

```bash
pnpm openmapx services enable overpass
```

Before you start it, give it data — see the next section. Once the data is in
place, bring it up:

```bash
pnpm openmapx services start overpass
```

There is no separate build step for Overpass. The container imports its database
on first boot (its manifest sets `OVERPASS_MODE=init`), then switches to serving
queries. The import is slow — hours for a country, a day or more for the planet —
so watch the logs the first time:

```bash
pnpm openmapx services logs overpass --follow
```

The healthcheck allows a long startup window precisely because the initial import
takes so long; the container won't be flagged unhealthy while it's still ingesting.

## Preparing the data

Overpass consumes OSM data in **bzip2** form, not the `.osm.pbf` that everything
else reads. So unlike most engines, you do a one-time format conversion after the
download. Start by downloading the extract for your region the usual way (covered
in full under [Preparing data](../install/preparing-data.md)):

```bash
pnpm openmapx data download osm europe/germany
```

Then derive the bzip2 variant Overpass needs. The region is a positional
argument:

```bash
pnpm openmapx data convert overpass europe/germany
```

This reads the matching `.osm.pbf` and writes `data/osm-bz2/data.osm.bz2`,
compressing in parallel across your CPU cores. If you've set `OVERPASS_REGION`
(or the more general `OPENMAPX_REGION`) in `infra/docker/.env`, you can drop the
positional argument and let it resolve from there:

```bash
pnpm openmapx data convert overpass
```

With the bz2 in place, render and link so the file is wired into the Overpass
container, then start the service:

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start overpass
```

`data link` hardlinks the converted file into the directory Overpass mounts, so
the bytes live on disk once no matter how many services share them. The
`data update` all-in-one refresh also covers this when Overpass is in your
selection.

:::tip[Pick the smallest region that covers you]
You only need Overpass data for the area your instance serves. A single country
is a few gigabytes of database and an import measured in hours; a continent is
several times that; the planet is roughly 200 GB and an import that runs more
than a day. Choosing a tight region is the single biggest lever on cost here.
:::

## Resource cost

Overpass is one of the most demanding services OpenMapX runs. It keeps the full
tagged OSM database on disk and holds working set in memory, so both scale with
the area you import:

| Scale | Approx. database | Approx. import time |
| ----- | ---------------- | ------------------- |
| Single country | tens of GB | a few hours |
| Continent | ~100 GB or more | many hours |
| Planet | ~200 GB | a day or more |

Plan disk and RAM against your chosen region before you start the import — see
[Requirements](../install/requirements.md) for the full sizing breakdown and how
it compares to the other heavy engines. Two knobs in `infra/docker/.env` are worth
knowing about:

```bash
# Maximum disk the Overpass database may use, in bytes (default ~100 GB).
# Raise this for planet-scale imports.
OVERPASS_SPACE=214748364800

# Parallel query workers; raise for higher query throughput.
OVERPASS_FASTCGI_PROCESSES=4
```

These resolve at render time, so change them in `.env`, then re-render and
recreate the service for the change to take effect:

```bash
pnpm openmapx compose render
pnpm openmapx services recreate overpass
```

Once it's serving, Overpass keeps itself current by applying OSM's daily
replication diffs automatically — there's no periodic re-import to schedule.

## Verifying it works

A minimal query confirms the API is up. From the host, Overpass is bound to
loopback on port 8082 — the same `/api/interpreter` endpoint the container's own
healthcheck probes:

```bash
curl 'http://localhost:8082/api/interpreter?data=[out:json];node(1);out;'
```

That only proves the API answers. To confirm the import actually loaded data,
ask for real features in a box you know is populated and count what comes back —
a non-zero count means the database is built and serving:

```bash
curl -s 'http://localhost:8082/api/interpreter?data=[out:json];node[amenity=cafe](52.5,13.3,52.6,13.5);out;' | jq '.elements | length'
```

The status endpoint reports the database timestamp and how current the diffs are:

```bash
curl 'http://localhost:8082/api/status'
```

If the response is empty or the count is zero, the import probably hasn't
finished — check the logs. Inside the stack, OpenMapX reaches the same service at
`http://overpass:80`; the public port is for your own diagnostics, not for the
app.

To rebuild from a fresh extract rather than wait on diffs, stop the service,
clear its database directory (a plain bind mount at `data/overpass/db`, not a
named volume), re-link the new bz2, and start again — the import re-runs on boot:

```bash
pnpm openmapx services stop overpass
rm -rf infra/docker/data/overpass/db/*
pnpm openmapx data link
pnpm openmapx services start overpass
```

## Where to go next

- **[Map layers & overlays](../features/map-layers.md)** — the cycling, hiking,
  and nautical overlays Overpass feeds, and how the picker hides an overlay whose
  backend isn't running.
- **[Search](../features/search.md)** — where OSM-backed category search fits
  alongside the geocoders.
- **[Supporting infrastructure](./supporting-infrastructure.md)** — the database,
  cache, and proxy services that round out a self-hosted deployment.
- **[Cost optimization](./cost-optimization.md)** — deciding which heavy engines,
  Overpass among them, are worth self-hosting for your usage.
