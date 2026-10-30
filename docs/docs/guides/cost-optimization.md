---
title: Cost and resource optimization
description: Reduce local engine and data costs while preserving coverage, recovery, and provider compliance.
sidebar_position: 7
---

# Cost and resource optimization {/* #cost--resource-optimization */}

Start with the services and geographic coverage your users need. Measure runtime,
preparation, and refresh peaks separately. Manifest memory limits describe
container ceilings; they do not establish a tested host minimum or typical use.

## 1. Run only the engines you need

Inspect the desired and effective selection, then the actual containers:

```bash
pnpm openmapx services selected
pnpm openmapx services status
```

To retire an unused engine, stop it before removing it from the rendered stack:

```bash
pnpm openmapx services stop osrm
pnpm openmapx services disable osrm
pnpm openmapx compose render
pnpm openmapx services start app-api
pnpm openmapx services selected
```

Another root can still select a dependency. Disabling alone neither stops a
container nor reclaims its data. Keep source and backup data until you have
verified the replacement service and recovery plan.

The default effective core includes data-manager and transitous-runner, with
8 GiB and 4 GiB ceilings respectively. A hosted-only feature configuration does
not remove those services. See [Requirements](../install/requirements.md) rather
than assuming the entire stack has a proven 4 GiB minimum.

## 2. Use hosted fallbacks instead of self-hosting

Hosted providers reduce local import and storage work, but each has its own
coverage, credentials, terms, quotas, and privacy boundary.

| Capability         | Available hosted path                             | Check before use                                                            |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Geocoding          | MapTiler; Photon and Nominatim provider fallbacks | Provider chain, key where needed, permitted query type and aggregate volume |
| Driving            | OSRM demo fallback                                | Usage policy and availability; arrange a suitable production endpoint       |
| Multimodal routing | Stadia Valhalla fallback                          | API key and account terms                                                   |
| OSM queries        | Public Overpass endpoints                         | Shared-server limits and workload                                           |
| Transit            | Separate public Transitous provider               | Coverage and local-only capabilities that will be unavailable               |
| Vector basemap     | Keyless OpenFreeMap or MapTiler                   | Attribution, external requests, availability, and key for MapTiler          |

A configured fallback URL is not permission to use a public instance without
limits. In particular, the
[public Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
limits an application's aggregate traffic to at most one request per second and
forbids autocomplete. Use a local or contracted provider for autocomplete or
higher volume. Review each other provider's policy separately; there is no
single ban on all commercial use across these services.

Server-side integrations proxy their queries through OpenMapX, so the upstream
sees the server address and request data. Browser-loaded OpenFreeMap tiles and
glyphs contact the provider directly. Self-hosting only the basemap does not
remove other external data requests, terrain sources, imagery, or feed downloads.

Set endpoints through the relevant integration or direct-helper configuration.
Many adapters prefer a selected local service over their `endpoint` value;
remove that local selection and recreate API when switching to an external
instance. See [Backend endpoint overrides](../install/configuration.md#backend-endpoint-overrides).

## 3. Scope data to a region, not the planet

```dotenv
OPENMAPX_REGION=europe/germany
TRANSITOUS_COUNTRIES=de
```

Download only the OSM extract needed for your routes, and build explicit targets:

```bash
pnpm openmapx data download osm europe/germany
pnpm openmapx services build osrm --region europe/germany
```

An existing OSRM must be stopped before that build. `data update` is not a
selected-services shortcut: it queues transit sync and builds all installed
buildable engines. See [Preparing data](../install/preparing-data.md).

Photon's `PHOTON_REGION` and BRouter's `SERVICE_BROUTER_REGION` select separate
upstream downloads. Transit country/feed scope is independent of the PBF region.
OTP stages every ZIP in `data/gtfs/`, so keep that set appropriate to its graph.

## 4. Pick the lighter engine in each category

Choose from measured workloads rather than ranking engine limits as usage:

- Photon skips a local OSM import by downloading an index. Its parallel refresh
  needs both old and new data. Nominatim provides different search/enrichment
  behavior and has a substantial import; Pelias adds several cooperating services.
- OSRM can serve regional driving. Valhalla serves additional modes, time-aware
  requests, and elevation; optional BRouter downloads prepared cycling segments.
- MOTIS supports managed regional refresh and rollback. OTP has an offline graph
  build with a 24 GiB default build heap. Its regional scope does not by itself
  make it cheaper than MOTIS. Planet MOTIS is experimental.

The [geocoder](./geocoders.md), [routing](./routing-engines.md), and
[transit](./transit-engines.md) guides describe the preparation and capability
trade-offs.

## 5. Build heavy, then run lean

Stagger initial imports so peaks do not overlap. Reserve room for simultaneous
active and staging MOTIS slots and for complete replacement artifacts. Hardlinks
save repeated inputs; they do not eliminate index or temporary build storage.

For OSRM, OTP, Pelias, MOTIS, and TileServer GL, supported artifact bundles can
move preparation to a larger machine. Use the same OpenMapX revision and matching
runtime image pins, stop consumers, and import a checksummed bundle. See
[Building on another host](../install/preparing-data.md#building-on-another-host).
Valhalla, Nominatim, and Overpass have no supported bundle path here.

Do not budget swap as additional usable container memory. Runtime limits and
Docker memory/swap configuration can still kill a build; heavy swapping can also
make query latency unacceptable.

## 6. Skip self-hosted tiles

A hosted OpenMapTiles-compatible source still uses the bundled OpenMapX styles.
You do not need a local tile build to keep that presentation. A local TileServer
GL is useful for data control and the local offline-package source, but needs
MBTiles, glyphs, preparation workspace, and update capacity. Martin is independent
and serves database-derived overlays, not the basemap.

Even with local vectors, terrain defaults to an external DEM through the API
proxy unless you configure your own. See [Self-hosting map tiles](./map-tiles.md)
for external dependencies and offline limits.

## Putting it together: a minimal viable stack

For a fresh deployment with no custom selection, the default roots provide the
application and hosted-capable integrations:

```bash
pnpm openmapx services selected
pnpm openmapx compose up
```

Configure credentials and provider participation, then verify search, directions,
and any transit features you intend to offer. Add one local engine at a time,
measure preparation and serving costs, and retain enough disk for replacement
builds and recovery. A healthy core does not guarantee every hosted feature is
configured or available.

## Where to go next

- [Requirements](../install/requirements.md) for host and capacity constraints.
- [Managing services](../install/managing-services.md) for selection and lifecycle.
- [Preparing data](../install/preparing-data.md) for targeted updates and cleanup.
