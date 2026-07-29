---
title: Self-hosting routing (Valhalla & OSRM)
description: Run your own Valhalla and OSRM routing engines — when to use each, how to download data, build the graph, and wire it into the routing integration.
sidebar_position: 1
---

# Self-hosting routing engines

OpenMapX computes driving, cycling, and walking directions by delegating the
path-finding to a routing **engine**. Two engines ship in the box, and you can
run either or both as backend services on your own host:

- **Valhalla** — the general-purpose engine. It routes for all three ground
  modes, scales to a planet extract, and is the only one that produces elevation
  profiles, honors departure/arrival times, and does map matching.
- **OSRM** — a region-scoped, driving-only engine optimized for speed.

This guide is the operator's view: deciding which to run, getting the data,
building the graph, and pointing the routing integration at it. For the
user-facing behavior — route options, navigation, the elevation chart — see
[Directions & navigation](../features/directions.md). For the service and
integration model underneath all of this, see [How it works](../overview/how-it-works.md).

## Choosing an engine

The two engines are complementary, not redundant, and the routing orchestrator
picks between them by capability rather than hard-wiring either one:

| | Valhalla | OSRM |
| --- | --- | --- |
| Modes | driving, cycling, walking | driving only |
| Scale | region or **planet** | **region only** |
| Speed | fast | fastest |
| Elevation profiles | yes (SRTM) | no |
| Time-aware routing | yes (departure/arrival) | no |
| Map matching | yes | no |
| Build step | none (builds on first start) | required (`services build osrm`) |

A useful way to think about it:

- **Run Valhalla if you run anything.** It serves all three modes on its own, so
  a Valhalla-only deployment is complete. It is also your only option for
  worldwide coverage — OSRM can't load a planet graph.
- **Add OSRM when driving volume matters and you're region-scoped.** Where a
  regional OSRM build exists, the orchestrator routes car requests through it for
  the fastest possible response, and still falls back to Valhalla whenever OSRM
  is absent or briefly unreachable.

Because providers are selected per request, running both never hurts: cycling
and walking always go to Valhalla, driving prefers OSRM and degrades gracefully.

:::tip[Planet deployments use Valhalla alone]
OSRM loads its entire graph into RAM and can't handle a planet extract (the build
command refuses one outright). For worldwide routing, enable only Valhalla and
let it serve driving too. See the [routing rows in Requirements](../install/requirements.md#engine-sizing)
for the sizing that drives this.
:::

## Enabling the service

Routing engines are backend services, managed with the `openmapx` CLI. Add the
engine(s) you want to your selection — Valhalla, OSRM, or both:

```bash
pnpm openmapx services enable valhalla        # planet-capable, all three modes
pnpm openmapx services enable osrm            # fast region-only driving (optional)
```

There's a `routing` preset that bundles both, handy on the lifecycle commands:

```bash
pnpm openmapx services start --preset routing
```

Enabling only changes the selection; it doesn't start anything yet — you still
need data and (for OSRM) a build. The full vocabulary of enable, render, start,
and configure lives in [Managing services](../install/managing-services.md).

## Downloading the OSM extract

Both engines build from an OpenStreetMap extract. Download one for your region
through the data-manager; OpenMapX uses Geofabrik's path naming, so a region is a
slash-separated path like `europe/germany`, or the literal `planet`:

```bash
pnpm openmapx data download osm europe/germany   # or "planet" for Valhalla
```

This lands the region's `.osm.pbf` in `data/osm/`. A single country is modest; a
continent is several times larger; the planet is an order of magnitude bigger
again — and only Valhalla can consume it. Pick the smallest region that covers
the area you need to route across (a route can't cross the edge of its extract).
See [Preparing data](../install/preparing-data.md) for the full data workflow,
region naming, and the one-command `data update` refresh.

## Valhalla: no build step, builds on first start

Valhalla is unusual among the heavy engines: it has **no separate build
command**. The scripted image (`ghcr.io/valhalla/valhalla-scripted`) reads the
OSM extract and builds its routing tiles inside the container the first time it
starts, then begins serving on port `8002`.

After the extract is downloaded, render the stack, link the data into place, and
start the service:

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start valhalla
```

The first start is the slow one — the container builds tiles, and by default
also downloads SRTM elevation data and builds admin-boundary and time-zone
databases. Watch progress in the logs; the service goes healthy once tiles are
loaded:

```bash
pnpm openmapx services logs valhalla --follow
```

Subsequent starts reuse the built tiles and come up quickly. To rebuild against a
newer extract, re-download, re-link, and restart — the container rebuilds tiles
from the fresh data.

### Tuning the Valhalla build

Valhalla's manifest exposes two operator toggles through its `configSchema`, both
on by default:

- **`build_elevation`** — download SRTM elevation tiles during the build. This is
  what powers the [elevation profiles](../features/directions.md#elevation) on
  cycling and walking routes. Elevation data adds meaningful disk and build time;
  turn it off if you don't need profiles.
- **`build_admins`** — build admin-boundary data, used for country-specific
  routing rules (driving side, access restrictions). Recommended on.

A third, related toggle isn't in the `configSchema` but is set in the manifest's
container environment: **`build_time_zones`** (also on by default) builds the
timezone database that backs time-aware departure/arrival routing. Leave it on
unless you're certain you never pass departure or arrival times. All three
auxiliary databases are built once during the first-start tile build and reused
on subsequent starts.

Set these like any service config — environment variable wins, then the admin
panel, then the schema default. The env-var form is `SERVICE_VALHALLA_<KEY>`:

```bash
# infra/docker/.env
SERVICE_VALHALLA_BUILD_ELEVATION=false
```

Because config resolves at render time, re-render and apply after a change:

```bash
pnpm openmapx compose render
pnpm openmapx services start valhalla
```

The deeper tuning knobs live in the bind-mounted config file at
`services/valhalla/config/valhalla.json`:

- **`mjolnir.concurrency`** (default `8`) — tile-build thread count. Lower it to
  cap peak memory on a constrained build host; the build slows but uses less RAM.
- **`service_limits`** — per-mode request ceilings that bound resource use:
  `auto` max 5,000 km / 20 locations, `bicycle` 500 km, `pedestrian` 250 km,
  `isochrone` 4 contours up to 120 min. Raise these only if you intend to serve
  larger queries — they're the guardrails against a single request eating CPU.

The [config cascade](../install/managing-services.md#configuring-a-service)
explains how all of this resolves.

## OSRM: build the graph first

OSRM can't read a raw `.osm.pbf` — it needs a graph prepared by its three-stage
pipeline (`osrm-extract` → `osrm-partition` → `osrm-customize`). OpenMapX runs
those stages for you, in a Dockerized helper, through the service build hook.

After downloading the extract, build the graph for your region. On
`services build`, the region is the `--region` flag:

```bash
pnpm openmapx services build osrm --region europe/germany
```

The `data` namespace offers the same thing as a compatibility alias, where the
region is a **positional** argument instead:

```bash
pnpm openmapx data build osrm europe/germany
```

Either form stages the prepared graph (`region.osrm` and its companion files)
into `data/osrm-graph/`. The build is cached on a hash of the input PBF, so
re-running it when nothing changed is essentially free.

:::caution[Stop OSRM before rebuilding]
The build stages new files into the directory the running container reads from.
To avoid a half-swapped state, the build **refuses to run while `osrm` is up** —
stop it first, build, then start it again:

```bash
pnpm openmapx services stop osrm
pnpm openmapx services build osrm --region europe/germany
pnpm openmapx services start osrm
```
:::

Once the graph exists, render, link, and start as usual:

```bash
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start osrm
```

The container serves on port `5000` using the Multi-Level Dijkstra algorithm
(`--algorithm mld`), a good balance of preprocessing cost, RAM, and query speed.
The alternative, Contraction Hierarchies (`ch`), queries faster but costs far
more RAM and preprocessing time and forfeits the live segment-speed updates MLD
allows — which is why OpenMapX standardizes on `mld`.

:::note[Planet is refused]
`services build osrm --region planet` fails by design — a planet OSRM build needs
on the order of 200 GB of RAM. The error points you at Valhalla, which handles
worldwide driving on a fraction of that.
:::

OSRM has no incremental update path: to pick up newer OSM data, re-download the
extract, rebuild the graph, re-link, and restart. While the rebuild runs, the
live container keeps serving the old data from memory; there's only a brief gap
during the restart, and driving falls back to Valhalla in the meantime.

### Customizing the car profile

OSRM's routing behavior — speed assumptions per road class, turn penalties,
access rules — comes entirely from the `car.lua` profile baked into the image at
`/opt/car.lua`. To change it, mount your own Lua over that path during the build
(the speed file flag is already wired for traffic overrides):

```bash
docker run --rm \
  -v "$(pwd)/infra/docker/data/osrm-graph:/data" \
  -v "$(pwd)/services/osrm/car.lua:/opt/car.lua:ro" \
  ghcr.io/project-osrm/osrm-backend:latest \
  /bin/sh -c "osrm-extract -p /opt/car.lua /data/region.osm.pbf && \
              osrm-partition /data/region.osrm && \
              osrm-customize /data/region.osrm"
```

The profile is hashed into the build cache key alongside the PBF, so changing it
forces a rebuild even when the data is unchanged. Re-link and restart afterwards.

## Verifying the engine

Once a service reports healthy, probe it directly to confirm it actually routes.
Both engines bind their host port to `127.0.0.1`, so these run from the Docker
host itself: Valhalla on `8002`, OSRM on `5000`.

**Valhalla.** The cheapest liveness check is the `/status` endpoint the manifest
health check already uses — it answers as soon as tiles are loaded:

```bash
curl -s http://localhost:8002/status | jq
```

For an end-to-end check, ask for a real route. Valhalla accepts the request as
JSON on a `GET ?json=` query or a `POST` body; `.trip.summary` carries the
distance and time:

```bash
curl -s -X POST http://localhost:8002/route \
  -H 'Content-Type: application/json' \
  -d '{"locations":[{"lat":52.52,"lon":13.405},{"lat":48.137,"lon":11.575}],"costing":"auto"}' \
  | jq '.trip.summary'
```

Swap `costing` to `bicycle` or `pedestrian` to confirm the non-driving modes,
and hit `/isochrone` or `/height` the same way if you rely on travel-time
polygons or elevation profiles.

**OSRM.** OSRM takes coordinates inline as semicolon-separated `lng,lat` pairs.
A healthy instance returns `"code": "Ok"` with a distance and duration:

```bash
curl -s 'http://localhost:5000/route/v1/driving/13.405,52.52;11.575,48.137?overview=false' \
  | jq '.code, .routes[0].distance, .routes[0].duration'
```

:::note[OSRM has no built-in health check]
Unlike Valhalla, the OSRM manifest declares no `healthcheck`, so `services status`
can't tell you whether it's actually serving — only that the container is up. The
`/route` probe above is the real readiness signal; in the logs, `running and
waiting for requests` marks the server as ready. To get a Docker-native health
state, add a `healthcheck` block to `services/osrm/service.json` and re-render.
:::

A `NoRoute` / `NoSegment` from OSRM, or `No path could be found` from Valhalla,
almost always means a waypoint fell outside the extract or off a routable road —
not an engine fault. Widen the region (or use the planet extract on Valhalla) and
make sure both endpoints sit on a drivable road.

## How the routing integration finds your engine

The routing integrations don't hold a hard-coded address for their engine; they
resolve it through the **`routing-engine` capability**. Both `valhalla` and
`osrm` services declare `provides: ["routing-engine"]`, and the engine adapters
(`routing-valhalla`, `routing-osrm`) declare an *optional* requirement on the
matching service. At startup each adapter is bound to its local service and
reaches it over the private Docker network — `http://valhalla:8002`,
`http://osrm:5000` — with no configuration on your part.

Each adapter also exposes an **endpoint** setting in its manifest and the admin
panel, resolved through the standard config cascade. Leave it blank to use the
self-hosted service resolved by capability. Set it to point at a
Valhalla- or OSRM-compatible host elsewhere instead:

- **`routing-valhalla`** — a Valhalla endpoint URL and optional API key. Left
  blank, it uses your local `valhalla` service; with no local service and no
  override it falls back to a hosted Valhalla (which needs a key).
- **`routing-osrm`** — an OSRM endpoint URL. Left blank, it uses your local
  `osrm` service, or falls back to the public OSRM demo (rate-limited, for
  evaluation only — not production).

The practical upshot: enabling and starting the service is all the wiring most
deployments need. The capability binding does the rest. Read more about exposure
and the capability model in [How it works](../overview/how-it-works.md) and the
[service-manifest reference](../developer/service-manifest.md).

## Resource expectations

Both engines hold their routing data in memory, so RAM scales with the region you
build. The manifest memory ceilings are **16 GB for Valhalla** (sized for planet)
and **8 GB for OSRM** (region-scale); steady-state runtime use for a single
country is well under those limits. The expensive moments are the *builds* —
Valhalla's first-start tile build and OSRM's `osrm-extract` stage are both CPU-
and memory-hungry, and want a few GB to tens of GB of headroom depending on
region size.

For concrete RAM and disk figures by engine and geographic scale, see the
[engine-sizing table in Requirements](../install/requirements.md#engine-sizing).
Plan disk before you download: a planet extract plus Valhalla tiles and elevation
data is in the tens-of-GB-and-up range.

## Quick reference

A region-scale deployment running both engines, from nothing:

```bash
# Enable the routing stack
pnpm openmapx services enable valhalla osrm

# Get the OSM extract
pnpm openmapx data download osm europe/germany

# Build OSRM's graph (Valhalla needs no build step)
pnpm openmapx services build osrm --region europe/germany

# Render, link, and bring routing up
pnpm openmapx compose render
pnpm openmapx data link
pnpm openmapx services start --preset routing
```

Valhalla builds its tiles on that first start (tail the logs); OSRM comes up
immediately on the graph you just built. From there, cycling and walking route
through Valhalla, driving prefers OSRM, and both fall back to Valhalla when
needed.

## Where to go next

- **[Directions & navigation](../features/directions.md)** — what users get from
  these engines: route options, elevation, turn-by-turn.
- **[Managing services](../install/managing-services.md)** — enabling, rendering,
  building, configuring, and exposing services in depth.
- **[Preparing data](../install/preparing-data.md)** — the download/build/link
  pipeline and region naming.
- **[Requirements](../install/requirements.md)** — RAM and disk sizing before you
  commit to a region.
- **[Self-hosting transit engines](./transit-engines.md)** — the MOTIS/OTP
  counterpart for public-transit journey planning.
