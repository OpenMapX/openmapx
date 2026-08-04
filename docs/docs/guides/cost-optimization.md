---
title: Cost & resource optimization
description: Practical, prioritized strategies for running a lean OpenMapX deployment — minimizing RAM, disk, and CPU.
sidebar_position: 7
---

# Cost & resource optimization

OpenMapX scales from a 4 GB box to a planet-wide cluster, and the difference
between those two is almost entirely *which engines you turn on and how much
data you feed them*. The [Requirements](../install/requirements.md) page
explains the sizing model: a lightweight always-on core, plus optional heavy
engines you opt into. This guide builds on that model with the levers that move
the bill the most, roughly in order of impact.

The single idea underneath all of them: **you only pay for what you enable.**
Every geocoder, router, transit engine, OSM-query backend, and tile server is an
optional [service](../overview/how-it-works.md). Leaving one out is free, and
most can be replaced by a hosted endpoint with no loss of functionality.

## 1. Run only the engines you need

The core — `traefik`, `well-known`, `app-api`, `app-web`, `postgis`, `redis`,
and `data-manager` — is what runs by default, and it fits comfortably in ~4 GB.
Everything that pushes a host into the 16–64 GB range is one of the heavy
engines, each of which declares a memory ceiling in its
`services/<id>/service.json` manifest:

| Engine | Manifest RAM ceiling | What it buys you |
| ------ | -------------------- | ---------------- |
| Nominatim | 64 GB (import peak) | full geocoding, reverse, place enrichment |
| Overpass | 32 GB | OSM category / feature [queries](./osm-data-queries.md) |
| Valhalla | 16 GB | planet-scale [routing](./routing-engines.md) |
| MOTIS | 16 GB | planet-scale [transit](./transit-engines.md) |
| OTP | 16 GB | region-scale transit |
| Photon | 8 GB | search-as-you-type [geocoding](./geocoders.md) |
| OSRM | 8 GB | region-scale driving routes |
| Elasticsearch (Pelias) | 4 GB | composite geocoding store |

Before enabling any of these, ask which user-facing features you actually need.
If you don't offer transit directions, skip MOTIS and OTP. If you never surface
"restaurants near me" category browsing, skip Overpass. The cheapest engine is
the one you never start.

Check what's currently in your selection, and trim it:

```bash
pnpm openmapx services selected            # roots + effective set after expansion
pnpm openmapx services disable osrm otp    # drop what you don't use
pnpm openmapx services status              # confirm what's actually running
```

See [Managing services](../install/managing-services.md) for the full
enable / disable / render / start workflow.

## 2. Use hosted fallbacks instead of self-hosting

This is the biggest single saving, because it lets you delete a 64 GB engine and
its 330 GB database entirely. Every backend-facing engine has a **public-endpoint
default baked into the `app-api` manifest**, and the compose renderer only swaps
in the internal Docker address when you've actually co-deployed that service. In
other words, if a self-hosted engine isn't in your selection, OpenMapX
transparently reaches out to a public one instead:

| Capability | Hosted default it falls back to | Self-hosted engine you skip |
| ---------- | ------------------------------- | --------------------------- |
| Geocoding (full) | `nominatim.openstreetmap.org` | Nominatim |
| Geocoding (typeahead) | `photon.komoot.io` | Photon |
| OSM queries | `overpass-api.de` | Overpass |
| Driving routes | `router.project-osrm.org` | OSRM |
| Multi-modal routing | Stadia Maps Valhalla (`api.stadiamaps.com`) | Valhalla |
| Transit | Transitous / MOTIS cloud (`api.transitous.org`) | MOTIS |
| Map tiles | MapTiler Cloud fallback | TileServer GL |

A common lean deployment self-hosts nothing in this table: the [search](../features/search.md),
[directions](../features/directions.md), and [public-transit](../features/public-transit.md)
features all work against public endpoints, and the host stays close to the
~4 GB core baseline. You can then self-host engines selectively, one at a time,
as traffic or privacy needs grow.

:::caution[Hosted endpoints have trade-offs]
Public instances come with caveats you must weigh:

- **Privacy.** OpenMapX proxies these calls *through your server* rather than
  exposing them to the browser, so end users never talk to the third party
  directly — but your server does, and the upstream provider sees your traffic.
  Self-hosting is the only way to keep every query fully on your infrastructure.
- **Rate limits and terms.** The OSM-run Nominatim, Overpass, and OSRM demo
  servers are shared community resources with usage policies that prohibit heavy
  or commercial load. The Stadia Maps Valhalla default and MapTiler tiles need
  an API key and have free-tier limits. Read each provider's terms before
  pointing production traffic at it.
- **Latency and availability.** A public endpoint is one more dependency outside
  your control.

For anything beyond light or evaluation use, plan to self-host the engines that
carry your real query volume.
:::

To point an engine at a *specific* hosted host (for example, your own managed
Valhalla), set its URL in `infra/docker/.env` — `VALHALLA_URL` (isochrones /
elevation), `OVERPASS_URL`, `MOTIS_URL`, and so on; the routing providers take
`INTEGRATION_ROUTING_VALHALLA_ENDPOINT` / `INTEGRATION_ROUTING_OSRM_ENDPOINT`. An
explicit value always wins over both the public default and the internal address.

## 3. Scope data to a region, not the planet

After the engine list, geographic scope is the next-largest cost driver — it
sets download time, build time, RAM, and disk all at once. A single country is
modest; a continent is several times larger; the planet is an order of magnitude
more in every dimension.

Most operators do not need the planet. If your users are in one country or one
continent, build only that extract:

```bash
pnpm openmapx data update europe/germany
```

OpenMapX names regions with Geofabrik's paths (`europe/germany`,
`north-america/us/california`, or `planet`). Set `OPENMAPX_REGION` in your
`.env` so every download and build defaults to it. For transit, scope the GTFS
feed list the same way instead of pulling the worldwide catalog:

```bash
pnpm openmapx data sync --countries de,at,ch
```

See [Preparing data](../install/preparing-data.md) for the full region and feed
workflow.

:::note[Region scope also unlocks the lighter engines]
Two of the lightest routing/transit engines, **OSRM** and **OTP**, load their
entire graph into memory and only work at region scale — they can't fit a
planet. Choosing a region isn't just cheaper; it's what makes those engines an
option at all (see the next section).
:::

## 4. Pick the lighter engine in each category

When two engines provide the same capability, the lighter one is often enough —
especially once you've scoped to a region.

- **Geocoding: prefer Photon over Nominatim.** Photon's 8 GB ceiling is a
  quarter of Nominatim's import peak, it auto-downloads a prebuilt index instead
  of running a multi-hour import, and for search-as-you-type it's a great fit.
  Add Nominatim only when you specifically need full reverse geocoding and rich
  place enrichment. You almost never want all three geocoders (Photon,
  Nominatim, Pelias) at once — pick the one that matches your needs and skip the
  rest. See [Geocoders](./geocoders.md).
- **Driving routes: prefer OSRM over Valhalla for a region.** For a region-scale
  car deployment, OSRM (8 GB) is lighter than Valhalla (16 GB). Reach for
  Valhalla when you need planet coverage, multiple travel modes, elevation, or
  isochrones — things OSRM doesn't do. See [Routing engines](./routing-engines.md).
- **Transit: OTP for one region, MOTIS for the world.** OTP is region-only;
  MOTIS handles a worldwide feed set. See [Transit engines](./transit-engines.md).

## 5. Build heavy, then run lean

Several engines need far more RAM to *build* their index than to *serve*
queries afterward. Nominatim's 64 GB ceiling is its import peak; steady-state
runtime use is a small fraction of that. The same gap applies to Overpass.

You can exploit this in two ways:

- **Stagger the builds.** If you're memory-constrained, bring the heavy engines
  up one at a time and let each finish its initial import before starting the
  next, rather than building them all in parallel and stacking the peaks. The
  build helper skips work entirely when the input data is unchanged, so
  re-running the sequence is cheap.
- **Build elsewhere, then run smaller.** Because the build peak is transient,
  some operators do the expensive import on a large short-lived machine (a cloud
  spot instance, or a workstation with lots of RAM), then move the prepared data
  to a smaller, cheaper host for steady-state serving. The data tree under
  `infra/docker/data/` is self-contained and portable.

A swap file can carry an import over a brief RAM shortfall too, at the cost of a
much slower build — useful for a one-time Nominatim import on an otherwise
right-sized box, but never for runtime, where swapping wrecks query latency.

## 6. Skip self-hosted tiles

Self-hosted tiles are convenient to overlook as a cost, but they aren't free:
TileServer GL needs an ~80 GB planet MBTiles archive plus its own build, and the
glyph download is another step in your pipeline. If you're
running lean, keep the hosted MapTiler fallback and skip TileServer GL and
Martin entirely — along with the
`openmapx data download fonts` step and the MBTiles build.

Self-host tiles when you need full control over styling or want zero external
tile dependencies; otherwise a hosted provider is the cheaper default.

## Putting it together: a minimal viable stack

The leanest useful deployment is the **core plus nothing self-hosted**, leaning
on hosted fallbacks for every backend capability:

```bash
# Core only — search, routing, transit, tiles all via hosted endpoints
pnpm openmapx services selected     # should show just the core
pnpm openmapx compose up
```

That stays near the ~4 GB / 2-core / ~20 GB baseline. From there, self-host
engines one at a time as your needs (privacy, volume, control) justify their
cost — starting with the category that carries your heaviest traffic, scoped to
the smallest region that covers your users, and reaching for the lighter engine
in each category first.

## Where to go next

- **[Requirements](../install/requirements.md)** — the full sizing model and
  per-engine RAM/disk figures these strategies trim.
- **[Managing services](../install/managing-services.md)** — enabling,
  disabling, rendering, and running the engines you choose.
- **[Preparing data](../install/preparing-data.md)** — scoping downloads and
  builds to a region.
