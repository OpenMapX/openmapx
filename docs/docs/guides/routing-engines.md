---
title: Self-hosting routing engines
description: Prepare and run Valhalla, OSRM, and optional BRouter bicycle routing.
sidebar_position: 1
---

# Self-hosting routing engines

Complete [Getting started](../install/getting-started.md) before preparing routing
data. The examples assume a healthy data-manager, local Docker access, and enough
space for the input and prepared graph. Diagnostic commands run on the Docker
host; published engine ports bind to loopback.

## Choosing an engine

| Engine   | Use                                                                                   | Preparation                                                    |
| -------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Valhalla | Driving, motorcycle, cycling, walking, elevation, time-aware routes, and map matching | Imports OSM and auxiliary data on startup                      |
| OSRM     | Regional driving routes                                                               | Explicit graph build; `planet` and PBFs over 50 GB are refused |
| BRouter  | Optional cycling routes with bicycle profiles                                         | Downloads prebuilt regional segments; no PBF build             |

Valhalla can serve all supported ground modes. OSRM adds a driving provider;
BRouter adds cycling preferences. Request features and provider availability
affect selection, so verify the modes you use after setup. A selected provider
that cannot answer may fall back to another configured provider.

:::tip[Planet deployments use Valhalla alone]
For worldwide general ground routing, use Valhalla rather than an OSRM graph.
Optional BRouter planet coverage is a separate segment download. Neither choice
establishes that the host has enough build memory or disk; see
[Requirements](../install/requirements.md#engine-sizing).
:::

## Enabling the service

```bash
pnpm openmapx services enable valhalla
# Optional regional driving engine:
pnpm openmapx services enable osrm
```

Enable changes the desired selection without starting containers. The `routing`
preset targets Valhalla and OSRM together; it does not enable or prepare either
one. Start only the engines whose inputs are ready.

## Downloading the OSM extract

```bash
pnpm openmapx data download osm europe/germany
```

Use a Geofabrik path covering both endpoints and the corridor between them.
`planet` is available for Valhalla. Files appear under
`infra/docker/data/osm/`; `OPENMAPX_REGION` sets the shared region default.
[Preparing data](../install/preparing-data.md) covers selection when more than
one extract exists and how hardlinks reach engine inputs.

## Valhalla: no build step, builds on first start

```bash
pnpm openmapx data link
pnpm openmapx services start valhalla
pnpm openmapx services logs valhalla --follow
```

The scripted Valhalla image prepares routing tiles and, by default, elevation,
administrative boundaries, and time zones. Its internal endpoint is
`http://valhalla:8002`, published as `127.0.0.1:8002`. Initial preparation can take
hours. Follow logs rather than treating a running container as a loaded graph.

Existing tiles are reused on later starts. When refreshing OSM, download the new
extract, re-link, and restart the service during a maintenance window. Inspect
logs to confirm the image detected the changed input and completed rebuilding;
verify a route afterward.

### Tuning the Valhalla build

The schema exposes `build_elevation` and `build_admins`, both enabled by default:

```dotenv
SERVICE_VALHALLA_BUILD_ELEVATION=false
```

Apply changes with `pnpm openmapx services start valhalla`. Disabling elevation
removes the data needed for local elevation profiles. Time-zone preparation is
enabled in the manifest environment, independently of those two schema fields.

`services/valhalla/config/valhalla.json` sets build concurrency to 8 and bounds
request sizes. Current limits include 5,000 km/20 locations for driving,
500 km for cycling, 250 km for walking, and four isochrone contours up to
120 minutes. Change tracked engine configuration only as a deliberate custom
configuration and verify the generated result. Larger limits increase resource
exposure; they do not enlarge geographic data coverage.

## OSRM: build the graph first

```bash
pnpm openmapx services build osrm --region europe/germany
pnpm openmapx services start osrm
```

The build runs extract, partition, and customize in Docker, then publishes
`data/osrm-graph/region.osrm` and companion files. It renders and links the
result. The equivalent positional-region alias is:

```bash
pnpm openmapx data build osrm europe/germany
```

The runtime uses `osrm-routed --algorithm mld` and listens internally at
`http://osrm:5000`, published as `127.0.0.1:5000`.

:::caution[Stop OSRM before rebuilding]
Preparation refuses a running OSRM consumer. New output is staged separately,
but the build is an offline operation with downtime:

```bash
pnpm openmapx data download osm europe/germany
pnpm openmapx services stop osrm
pnpm openmapx services build osrm --region europe/germany
pnpm openmapx services start osrm
```

A failed build preserves the previous graph. Correct the failure or restart the
previous graph; do not assume the container kept serving during preparation.
:::

The cache includes the PBF hash, runtime image, profile path, and traffic CSV
content. An unchanged build can be skipped. A planet filename or PBF larger
than 50 billion bytes fails before preprocessing.

### Optimizing waypoint order

OpenMapX keeps the first and last waypoints fixed. `optimizedOrder` contains
original input indexes in visit order; returned waypoints remain in request
order. Incomplete orders and responses spanning multiple trips are rejected.

### Customizing the car profile

The supported CLI build uses the image's `/opt/car.lua` profile. It has no
custom-profile flag or host-file mount. A manual build with a different profile
must use the exact runtime image and its own provenance/rebuild procedure;
it is outside the managed artifact workflow. The standard cache records the
profile **path**, not the contents of an arbitrary custom Lua file. Do not
assume editing a host `car.lua` changes `services build osrm`.

## Optional BRouter bicycle routing

```bash
pnpm openmapx services enable brouter
pnpm openmapx services start brouter
pnpm openmapx services logs brouter --follow
```

Set `SERVICE_BROUTER_REGION` to a Geofabrik extract path or `planet` before
starting; `europe/germany` is the default and `germany` is an accepted alias.
This region is independent of the PBF downloaded for other engines.

BRouter downloads prebuilt elevation-aware `.rd5` files from its
[official segment server](https://brouter.de/brouter/segments4/). It selects
existing 5-degree tiles overlapping the extract's bounding rectangle, including
neighboring areas. No separate elevation download or OSM graph build is needed.

| Setting                                   | Default                     |
| ----------------------------------------- | --------------------------- |
| `BROUTER_MEMORY`                          | `2g` container limit        |
| `SERVICE_BROUTER_JAVA_HEAP_MB`            | `1024`                      |
| `SERVICE_BROUTER_MAXTHREADS`              | `2` concurrent calculations |
| `SERVICE_BROUTER_REQUEST_TIMEOUT_SECONDS` | `30`, maximum `300`         |
| `SERVICE_BROUTER_UPDATE_INTERVAL_HOURS`   | `168`                       |

The pinned BRouter 1.7.10 software and segments live in the `openmapx-brouter`
volume, which is excluded from backups. Refresh prepares and checks a complete
replacement generation before publishing. Keep enough disk for both generations
plus the 1 GB reserve. A failed refresh retains the active generation and retries
after one hour. A changed region must prepare successfully before serving;
cached coverage for another region is not silently used. Startup has a 30-minute
health grace; large downloads may still require longer.

BRouter listens internally and on host loopback at `17777`;
`BROUTER_HOST_PORT` relocates the latter. Enable the `routing-brouter` integration
to use it for cycling. Touring/city, road, gravel, mountain-bike, hill, and quiet-road
preferences are routing preferences, not guarantees about conditions. Timed
routes and stop optimization use Valhalla. Gravel with ferry avoidance or strong
hill avoidance also uses Valhalla. Unavailable or out-of-coverage BRouter requests
can fall back to the configured Valhalla chain; no public BRouter endpoint is
selected automatically.

Preserve OpenStreetMap and elevation-data attribution when exposing or
redistributing results. The engine is MIT licensed; the routing data has its own
source notices, described in the [BRouter credits](https://brouter.de/).

## Verifying the engine

For Valhalla, check health and a real route in the prepared area:

```bash
curl --fail --silent --show-error http://localhost:8002/status
curl --fail --silent --show-error http://localhost:8002/route \
  -H 'Content-Type: application/json' \
  -d '{"locations":[{"lat":52.52,"lon":13.405},{"lat":48.137,"lon":11.575}],"costing":"auto"}' \
  | jq '.trip.summary'
```

Repeat with `bicycle` and `pedestrian` if needed. Check `/height` or `/isochrone`
if you rely on those capabilities. Alternative-route counts vary with geography
and overlap; two alternatives is a maximum, not an expected count for every trip.
`pnpm check-routing-canaries` exercises the application endpoint against its
configured live host; it is not an offline unit check.

OSRM has no Docker health check in its manifest. Verify the route response:

```bash
curl --fail --silent --show-error \
  'http://localhost:5000/route/v1/driving/13.405,52.52;11.575,48.137?overview=false' \
  | jq '.code, .routes[0].distance, .routes[0].duration'
```

Expect `"Ok"` and route distance/duration. `NoRoute`, `NoSegment`, or Valhalla's
no-path error can indicate missing coverage, disconnected roads, or an
unroutable endpoint. Check coordinates and logs before widening the region.
Finally test the corresponding route modes in OpenMapX and inspect attribution.

## How the routing integration finds your engine

Enable the matching `routing-valhalla`, `routing-osrm`, or `routing-brouter`
integration. These adapters resolve a selected local service first, then their
configured `endpoint`, then a provider-specific default. Integration environment
settings override admin values within config; they do **not** supersede the
selected-service lookup in these adapters.

To use an external endpoint, stop and remove the corresponding local service
from the selection, configure the integration endpoint, and recreate `app-api`
so its applied service selection is current. Valhalla's hosted Stadia fallback
requires its provider API key; self-hosted Valhalla does not. The OSRM public demo
is an external dependency with its own usage policy. Review permitted use before
sending application traffic. BRouter has no automatic public fallback.

The direct API helpers using `VALHALLA_URL` or `OSRM_URL` have separate endpoint
configuration. See [Configuration](../install/configuration.md#backend-endpoint-overrides)
when moving an engine outside this stack.

## Resource expectations

Default runtime ceilings are 16 GiB for Valhalla, 8 GiB for OSRM, and 2 GiB for
BRouter. Builds and replacement generations have separate peaks. Measure the
chosen region and preserve disk headroom; these limits are not minimum host
requirements or guarantees that a planet import fits.

## Quick reference

For a new regional deployment with core services already running:

```bash
pnpm openmapx services enable valhalla osrm
pnpm openmapx data download osm europe/germany
pnpm openmapx services build osrm --region europe/germany
pnpm openmapx services start --preset routing
pnpm openmapx services start app-api
```

For an existing deployment, stop OSRM before rebuilding. Valhalla prepares its
tiles on startup; OSRM needs the completed graph. Verify each engine directly
and then exercise directions in the application.

## Where to go next

See [Directions and navigation](../features/directions.md) for user behavior,
[Preparing data](../install/preparing-data.md) for artifact transfer, and
[Requirements](../install/requirements.md) for capacity planning.
