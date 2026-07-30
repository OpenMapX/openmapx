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

MOTIS reads an OSM extract for walking/cycling access and a compiled schedule
dataset. Download OSM, then ask the transactional source lifecycle to build and
promote the schedule dataset:

```bash
# OSM extract — Geofabrik path naming, or `planet` for the whole world
pnpm openmapx data download osm europe/germany

# Catalog feeds plus enabled operator sources, imported into an inactive slot
pnpm openmapx data sync --countries de,at,ch
```

The OSM step is optional for MOTIS but recommended — without it, MOTIS still
plans transit but can't draw street-level walking legs to and from stops. The
source lifecycle is covered under [Adding feeds](#adding-gtfs-feeds). MOTIS is
the only compiled static-schedule runtime; Postgres records operational source,
job, validation, and promotion metadata, not schedule rows.

### 3. Build the prepared data

`data sync` performs the normal build safely: it assembles config, attribution,
and source archives, imports them into an inactive slot, validates the static
contract, and promotes only after the candidate passes. The lower-level service
build remains useful when preparing an initial offline dataset:

```bash
pnpm openmapx services build motis --region europe/germany
# equivalent data-namespace alias:
pnpm openmapx data build motis europe/germany
```

`--region` selects the downloaded OSM extract; with `MOTIS_REGION` (or
`OPENMAPX_REGION`) set in `infra/docker/.env` you can omit it. Do not use a
manual stop/build/start sequence for feed changes on an operating deployment;
the transactional sync is what preserves the prior live dataset on failure.

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

The desired source set combines the pinned Transitous catalog with operator
sources. Inspect desired and active state together:

```bash
pnpm openmapx data source list
```

Catalog entries can be disabled and re-enabled. Both changes queue a complete
candidate sync rather than mutating the live engine in place:

```bash
pnpm openmapx data source remove catalog:de:vbb
pnpm openmapx data source enable catalog:de:vbb
```

Some catalog sources need API keys; generate a template, fill in the values you
have, then sync:

```bash
pnpm openmapx data generate-api-keys
# edit services/motis/tools/transitous/api-keys.json
pnpm openmapx data sync --countries de
```

To add a private operator URL or a feed the catalog does not carry, declare its
region, safe name, attribution, and license:

```bash
pnpm openmapx data source add https://example.org/agency-gtfs.zip \
  --name "Example Transit" \
  --region de-be \
  --attribution "Example Transit" \
  --license-spdx CC-BY-4.0
```

Every mutation returns a job id. Desired state changes immediately, while active
state changes only after the complete inactive-slot build and probes pass. A
failure retains the prior active sources and live dataset.

### Keeping feeds fresh: the staging pipeline

You don't have to rebuild MOTIS by hand to stay current. OpenMapX's data-manager
runs a daily **Transitous pipeline** that re-fetches feeds, imports them in the
inactive MOTIS slot with the staging container, validates the result with
functional queries, and only then promotes the candidate and recreates the
query-facing service. If a
feed turns up corrupt or an upstream is down, the partial run is abandoned and
your running engine is never touched.

`motis-staging` is opt-in — it only needs to run while a sync executes, and the
primary `motis` container is the only one that ever serves application traffic.
Enable it alongside MOTIS when you want the automated refresh:

```bash
pnpm openmapx services enable motis-staging
```

The pipeline, its lockfile-pinned Transitous ref, and the cron schedule live in
the data-manager service; leaving `motis-staging` enabled gives you a hands-off
daily update with retained-slot rollback.

#### Where the data comes from: `mirror` vs `build`

The pipeline can get its GTFS + MOTIS config two ways, selected by
`TRANSIT_SOURCE` in `infra/docker/.env`:

- **`mirror` (default)** — download Transitous's already-cleaned GTFS/NeTEx
  archives (`*.gtfs.zip` / `*.netex.zip`) for your countries directly from
  `api.transitous.org/gtfs/`, one request per feed. This skips the slow, fragile
  fetch + `gtfsclean` step entirely and inherits upstream's per-feed credential
  and scraper handling for free. Override the artifact source with
  `TRANSITOUS_ARTIFACT_BASE_URL`.
- **`build`** — clone the Transitous catalog and run its scripts (`fetch.py`,
  `generate-motis-config.py`) yourself: fetch each feed from its origin and
  `gtfsclean` it locally. Use this when you'd rather not depend on the upstream
  artifact server, or need a feed the published set doesn't carry yet.

Both modes scope to `TRANSITOUS_COUNTRIES` and are otherwise identical — the
MOTIS `config.yml` and attribution are generated locally from the catalog in
**both** modes (not taken from upstream), followed by the same staging →
smoke-test → atomic promote tail. **Realtime flows through your own feed-proxy**:
the generated config repoints mapped `rt.triptix.tech/feed/...` URLs and the
top-level `gbfs.proxy` that MOTIS uses for every discovered GBFS sub-resource.
The admin status reports hosted, mixed, and self-hosted modes from both values,
so operators can verify that no hidden hosted dependency remains. Switch modes
by setting `TRANSIT_SOURCE` and recreating the data-manager service.

`MOTIS_ROUTE_SHAPES=missing` is an optional generated-config override for feeds
that omit route shapes. It computes geometry from OSM only for those routes and
is off by default because it adds import time, index size, and RAM use. Validate
the measured cost in the inactive slot before enabling it; `all` is more
expensive.

A few specifics worth knowing as an operator:

- **Cadence.** The full sync runs on `TRANSITOUS_SYNC_CRON`, default `0 3 * * *`
  (daily 03:00 UTC — late enough for European publishers' nightly bundles, early
  enough to land before the morning). A separate staleness sweep
  (`TRANSITOUS_STALENESS_CHECK_CRON`, default `0 4 * * *`) flags feeds that have
  stopped updating. Set either to `disabled`, `off`, or `false` to turn it off
  (e.g. on staging where you trigger by hand).
- **Trigger one by hand.** `curl -X POST http://localhost:3001/api/data-manager/transit/sync`
  (admin session or `Authorization: Bearer ${DATA_MANAGER_AUTH_TOKEN}`) kicks off a
  run immediately; it's single-flight, so a manual call while a sync is already
  in flight returns the running job's id instead of starting a second one. Track
  progress at `GET /api/data-manager/transit/jobs`.
- **Pinned ref.** The active Transitous git ref (and its `transitland-atlas`
  submodule) is pinned in `infra/docker/transitous.lock.json` so an upstream
  catalog change never surprises a running deployment. Bump it by hand with
  `pnpm openmapx transitous show` / `pnpm openmapx transitous bump` (the bump
  writes a reviewable `*.proposed.json`; approval activates it).
- **Auto-bump (opt-in).** Set `TRANSITOUS_AUTO_BUMP_CRON` (e.g. `0 2 * * 1`,
  weekly Monday 02:00 UTC) to have the data-manager track upstream on its own.
  Each run resolves `origin/main`, proposes the candidate pin, **builds it into
  the staging slot and runs the same functional-probe canary the daily sync
  uses**, and activates the new pin + promotes **only if the whole pipeline
  passes**. On any failure the current pin is kept, the proposal is retained for
  review, and a failure alert fires (see below). Left unset, the pin stays frozen
  — the pin is a safety gate, so tracking upstream is a deliberate choice.
- **Failure alerts.** Set `TRANSITOUS_ALERT_GH_TOKEN` + `TRANSITOUS_ALERT_GH_REPO`
  so a failed sync or auto-bump opens a deduped GitHub issue. Without them,
  failures are log-only — and because the canary correctly refuses to promote a
  bad candidate, a persistent failure can silently freeze the live dataset at its
  last good build until someone reads the logs.
- **Rollback.** Promotion selects the validated inactive A/B slot. If the
  query-facing service fails its post-activation probes, the previous healthy
  slot is selected again without a reimport. A separate backup before update is
  optional; use one when required by local retention or disaster-recovery
  policy.

## Self-hosting OpenTripPlanner

OTP is the region-scale alternative. Its workflow mirrors MOTIS with one key
difference: OTP imports GTFS **at build time** into a serialized `graph.obj`, so
every feed change is a full rebuild rather than a restart.

### 1. Enable and get data

```bash
pnpm openmapx services enable otp

pnpm openmapx data download osm europe/germany     # required for OTP
pnpm openmapx data sync --countries de
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
to apply. The build step runs with a generous `-Xmx24g` JVM heap by default
(separate from the runtime container's `-Xmx12g`); a large region that fails the
build with an `OutOfMemoryError` usually just needs more build heap or fewer
feeds.

OTP also serves the GraphQL API (one of the reasons to pick it over MOTIS) at
`/otp/routers/default/index/graphql`, with a built-in GraphiQL explorer at
`http://localhost:8090/graphiql` for poking at the schema. OpenMapX itself only
uses the REST v1 plan endpoint, but the GraphQL surface is there for custom
queries.

After any feed or OSM change, OTP needs the full cycle again:

```bash
pnpm openmapx data sync --countries de
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

Start with a reachability check against the host-published port — both engines
publish on loopback only, so these run on the host itself:

```bash
# MOTIS — liveness (server is up; says nothing about whether a timetable loaded)
curl -s http://localhost:8081/api/v1/health

# OTP — router metadata (200 = a graph is loaded)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/otp/routers/default
```

Liveness is necessary but not sufficient: MOTIS answers `/api/v1/health` the
moment its server binds, *before* the timetable index is queryable. To confirm
the import actually succeeded, hit a query endpoint that needs loaded data. These
are the MOTIS v2 (2.10.x) paths — note the `map/` segment, which is easy to get
wrong:

```bash
# Stops in a bbox — empty array means the timetable index hasn't loaded
curl -s 'http://localhost:8081/api/v1/map/stops?min=52.51,13.36&max=52.54,13.38' | jq 'length'

# Native stop geocode — a name match proves the index is queryable
curl -s 'http://localhost:8081/api/v1/geocode?text=Berlin+Hbf' | jq '.[0].name'

# A single plan — exercises the routing engine end to end (adjust coordinates to your region)
curl -s 'http://localhost:8081/api/v1/plan?fromPlace=52.525,13.369&toPlace=48.140,11.558' | jq '.itineraries | length'
```

Static stop timetables use the stop's local civil day rather than UTC-day
boundaries. Route-pattern IDs are bound to the active dataset epoch, so do not
persist them across promotions. Pattern details and geometry rely on MOTIS's
experimental `/api/experimental/map/route-details` endpoint; OpenMapX pins the
MOTIS release and tests that response contract before promotion.

For OTP, the equivalent query-level probe is a plan against the REST v1 endpoint:

```bash
curl -s 'http://localhost:8090/otp/routers/default/plan?fromPlace=48.137,11.575&toPlace=48.142,11.580&mode=TRANSIT,WALK' | jq '.plan.itineraries | length'
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
