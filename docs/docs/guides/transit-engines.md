---
title: Self-hosting transit engines
description: Prepare regional MOTIS datasets or an OpenTripPlanner graph and verify transit planning.
sidebar_position: 3
---

# Self-hosting transit engines

Complete [Getting started](../install/getting-started.md) first. Transit needs
valid schedule feeds for the area and date being queried, enough preparation
capacity, and a working provider integration. A running container alone does
not prove a loaded timetable.

## MOTIS or OTP?

|                     | MOTIS                                                                             | OpenTripPlanner (OTP)                              |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Managed workflow    | Transactional schedule acquisition, candidate import, probes, promotion, rollback | Offline graph build and restart                    |
| Intended scope      | Regional by default; planet operation is experimental                             | Regional; planet input and PBFs over 50 GB refused |
| OSM                 | Recommended for assisted regional operation; required by sovereign/planet policy  | Required by the CLI build                          |
| Schedule inputs     | Pinned Transitous catalog and operator sources                                    | GTFS ZIPs staged locally before building           |
| OpenMapX adapter    | `transit-motis`, with local provider priority 1                                   | `transit-otp`, planning provider priority 6        |
| API used by adapter | MOTIS v2 REST                                                                     | OTP 2.10 GTFS GraphQL at `/otp/gtfs/v1`            |

Choose MOTIS for the managed schedule-refresh workflow. OTP can serve a regional
planning use case, but has no automatic graph refresh here. Its feasible feed
count depends on data size and the build heap; there is no fixed ten-feed limit.
See [Requirements](../install/requirements.md) before importing either engine.

## Self-hosting MOTIS

### 1. Enable the service

Enable the query engine and the candidate engine:

```bash
pnpm openmapx services enable motis motis-staging
```

Dependencies select `motis-feed-proxy`. Do not use `--preset transit` unless you
also intend to prepare and run OTP: that preset includes both engines.

Set the regional workflow in `infra/docker/.env` before preparing data:

```dotenv
MOTIS_OPERATIONS_PROFILE=regional-assisted
TRANSITOUS_COUNTRIES=de
MOTIS_OSM_REGION=europe/germany
MOTIS_TWO_SLOT=true
MOTIS_SLOT_MEMORY=16g
MOTIS_SLOT_MEMORY_GB=16
MOTIS_SLOT_CPU=4
TRANSITOUS_SYNC_CRON=disabled
```

Keep the scheduler disabled during initial preparation. The two memory settings
serve different purposes: `MOTIS_SLOT_MEMORY` sets each runtime container limit;
`MOTIS_SLOT_MEMORY_GB` reports capacity to preflight. Active and staging slots can
run together, so budget for both and for retained data generations.

`regional-sovereign` requires origin acquisition, local OSM, source/license
metadata, and an external egress policy. Planet operation requires explicit
confirmation and capacity; it is not obtained by leaving countries blank. Read
[MOTIS operations profiles](../administration/motis-operations-profiles.md) before
using either profile or migrating an existing live directory into A/B slots.

### 2. Get the source data

```bash
pnpm openmapx data download osm europe/germany
```

This OSM extract supplies street access/egress data. Assisted regional operation
can run without a matching extract, with reduced street routing; sovereign and
planet profiles reject that omission. The low-level CLI build below requires an
OSM input.

For restricted catalog feeds, generate and fill the key template first:

```bash
pnpm openmapx data generate-api-keys
# Edit infra/docker/secrets/transitous-api-keys/api-keys.json
```

Keep this file private. Data-manager mounts its directory read-only and reads
`/config/transitous/api-keys.json` at every run, so edits apply at the next one.
See the [secrets directory's README](https://github.com/OpenMapX/openmapx/blob/main/infra/docker/secrets/README.md)
for its layout. The release overlay must be selected before a
host-side MOTIS build so its helper image matches the release.

### 3. Build the prepared data

For an initial deployment, with neither MOTIS consumer running, seed its config,
feeds, license, and local feed-proxy configuration:

```bash
pnpm openmapx services build motis --region europe/germany
```

The positional-region alias is `pnpm openmapx data build motis europe/germany`.
`MOTIS_REGION` and `OPENMAPX_REGION` provide build defaults, independently of the
daemon's `MOTIS_OSM_REGION`. Keep them consistent with the selected dataset.

This low-level build writes prepared inputs in place. It is intended for initial
or off-host preparation, not routine updates to a serving dataset. Add `--import`
to `services build motis` when preparing an export on a larger machine; see
[Building on another host](../install/preparing-data.md#building-on-another-host).

### 4. Render, link, and start

```bash
pnpm openmapx data link
pnpm openmapx services start motis motis-staging
pnpm openmapx services start app-api data-manager
pnpm openmapx services logs motis --follow
```

The API and data-manager recreation applies their new service selection and
workflow environment. MOTIS starts with `motis import` followed by `motis server`.
The staging container can wait for its first generated config. A failed import
can leave a container running in a holding loop; inspect logs and query endpoints.

Now run the managed candidate workflow and monitor the returned job:

```bash
pnpm openmapx data sync --countries de
pnpm openmapx data source list
```

The primary endpoint is `http://motis:8080`, published on host loopback `8081`.
Staging uses loopback `8083` and does not serve application traffic. Both run
as the deployment's user, `UID:GID` from `infra/docker/.env`.

### Adding GTFS feeds

Inspect source IDs and desired/active state:

```bash
pnpm openmapx data source list
pnpm openmapx data source remove catalog:de:vbb
pnpm openmapx data source enable catalog:de:vbb
```

Use an ID actually present in your source list. For an operator source:

```bash
pnpm openmapx data source add https://example.org/agency-gtfs.zip \
  --name "Example Transit" \
  --region de-be \
  --attribution "Example Transit" \
  --license-spdx CC-BY-4.0
```

Replace the example URL and provenance with a real permitted feed. Each mutation
queues an asynchronous complete candidate build. Desired state changes before
active state; only successful promotion changes the live source set.

Operator URLs cannot embed credentials or point to private network addresses.
Acquisition uses a bounded, single-use relay; the private runner receives that
relay instead of the remote operator URL. Authenticated catalog feeds use the
key file. See [Transit schedule sources](../install/preparing-data.md#transit-schedule-sources)
for acquisition limits and protected inputs.

### Keeping feeds fresh: the staging pipeline

After the first sync and query checks pass, set `TRANSITOUS_SYNC_CRON=0 3 * * *`
in `.env` and recreate data-manager. The default schedule is daily 03:00 UTC;
`disabled`, `off`, or `false` disables it. Staleness checks default to daily
04:00 UTC and have the same disable values.

A sync acquires the requested feed set, prepares and probes a candidate, stops
the required processes, promotes the candidate, recreates the primary so Docker
resolves its data mount, and probes the stable endpoint. With A/B slots enabled,
a failed post-activation probe restores the prior healthy slot. There is a
bounded interruption during promotion; this is not a zero-downtime guarantee.

Keep both ops-agent and data-manager current before resuming promotion after an
upgrade. An unknown stop/recovery outcome requires container inspection; do not
retry promotion blindly. The [operations runbook](../administration/motis-operations-profiles.md#two-slot-activation-and-recovery)
explains the retained state and recovery boundary.

#### Where the data comes from: `mirror` vs `build`

`TRANSIT_SOURCE=mirror` downloads preprocessed Transitous GTFS/NeTEx artifacts;
`TRANSITOUS_ARTIFACT_BASE_URL` can select another artifact source.
`TRANSIT_SOURCE=build` runs the pinned catalog's acquisition scripts through the
private Transitous runner and fetches feeds from their origins. The regional
assisted profile defaults to mirror; sovereign operation requires build.

Both modes generate configuration and attribution locally and use the local
feed proxy for mapped realtime and GBFS resources. They still have external
source dependencies. Inspect the generated configuration and admin status when
checking a sovereignty requirement; application checks do not replace firewall
or DNS policy.

`MOTIS_ROUTE_SHAPES=missing` synthesizes absent route geometry from OSM. `all`
is more expensive. Both add preparation work and storage; measure candidate
imports before enabling them.

To inspect or advance the catalog pin:

```bash
pnpm openmapx transitous show
pnpm openmapx transitous bump
```

Bump asks permission to write a proposed Transitous pin into the operations
agent's state. It does not change the pin in effect or the running graph. Follow
[Pin upgrades](../administration/motis-operations-profiles.md#pin-upgrades)
to review the proposal, validate an inactive slot, and separately approve the
exact proposed ref. Opt-in `TRANSITOUS_AUTO_BUMP_CRON` tests a proposed upstream revision through the
candidate workflow before activating it. A rejection retains the previous pin.
Set `TRANSITOUS_ALERT_GH_TOKEN` and `TRANSITOUS_ALERT_GH_REPO` if failures should
open deduplicated issues; otherwise monitor logs and dataset age. A retained
healthy dataset can still become stale.

### Catalog pins

A release ships three catalog pins in `infra/docker/`:

- `transitous.lock.json`: the Transitous catalog the release was tested with.
  `transitous bump` and the auto-bump propose newer ones as described above;
  the agent keeps a proposal and an approved pin in its own state,
  `infra/docker/state/ops-agent/transitous/`, never in this file. An approved
  pin holds until a release ships a different one: that release's pin then
  takes over, the agent logs the approval it retired, and the auto-bump
  proposes again through its canary;
- `gbfs-catalog.lock.json`: the MobilityData GBFS registry revision and its
  SHA-256, paired with `MOBILITYDATA_GBFS_CATALOG_COMMIT` in
  `@openmapx/transitous-core`;
- `transport-apis.lock.json`: the public-transport/transport-apis revision the
  dynamic transit registry consumes, paired with its `pin.ts` and manifest
  health checks.

The operations agent reads the release's pins from the copies its image
carries, not from the host checkout, and no deployment command rewrites these
files.
Maintainers change the GBFS and transport-apis pins in a development checkout
and commit the result:

```bash
pnpm pin:gbfs-catalog      # the lock and the compiled commit
pnpm pin:transport-apis    # the lock, pin.ts and the manifest health checks
pnpm check-toolchain-pins
```

Each command shows the candidate and asks before it writes; `--yes` skips the
prompt. `pin:transport-apis` takes `--branch <name>` (default: the upstream
default branch).

## Self-hosting OpenTripPlanner

### 1. Enable and get data

```bash
pnpm openmapx services enable otp
pnpm openmapx data download osm europe/germany
```

Place permitted regional GTFS ZIP archives in `infra/docker/data/gtfs/` before
building. For example, copy an archive you have already obtained and validated:

```bash
mkdir -p infra/docker/data/gtfs
cp /path/to/agency.gtfs.zip infra/docker/data/gtfs/agency.gtfs.zip
```

The OTP build stages every top-level `.zip` in that directory; it does not
filter by the OSM region. Keep only compatible GTFS feeds for this graph there.
`data sync` is a MOTIS lifecycle operation, not an OTP-only download or updater.
It can supply catalog archives when MOTIS is configured, but does not rebuild OTP.

### 2. Build the graph

```bash
pnpm openmapx services build otp --region europe/germany
```

Preparation runs OTP 2.10.0 with `--build --save`, stages a replacement, then
publishes `data/otp-graph/graph.obj`. The build refuses `planet.osm.pbf` and
inputs over 50 billion bytes. Its default Java heap is `-Xmx24g`, independent
of the 16 GiB runtime container ceiling and `-Xmx12g` runtime heap.
`OTP_BUILD_JAVA_TOOL_OPTIONS=-Xmx8g` can reduce the build heap for a small graph;
reserve host overhead beyond the heap and measure a representative build.

Stop `otp` before rebuilding. Missing or invalid feeds can produce failed or
incomplete transit preparation even when street data is available.

### 3. Link and serve

```bash
pnpm openmapx services start otp
pnpm openmapx services start app-api
pnpm openmapx services logs otp --follow
```

Start re-renders and links automatically. The container uses `--load --serve`
and publishes `http://otp:8080` as host loopback `8090`. The release's build and
routing config files are `services/otp/config/`; change them with
[overrides](../install/managing-services.md#service-file-overrides) of
`otp/config/build-config.json` or `otp/config/router-config.json`. The graph
build reads the copy the applied configuration mounts, so render first. Rebuild
for build-config or input changes; recreate the runtime for container or router
configuration changes.

After refreshing the PBF or GTFS files:

```bash
pnpm openmapx services stop otp
pnpm openmapx services build otp --region europe/germany
pnpm openmapx services start otp
```

## Pointing the transit integration at your engine

Enable `transit-motis` for local MOTIS planning and related capabilities;
`geocoding-motis` supplies stop geocoding. A selected local service resolves
before integration config or `MOTIS_URL`. Without local MOTIS or an explicit
local endpoint, assisted deployments can use the separate public Transitous
provider. Features requiring the local static dataset are then unavailable.

`transit-otp` is a planning-only adapter. It resolves selected `otp` first, then
its configured `endpoint`, with development fallback `http://localhost:8090`.
`INTEGRATION_TRANSIT_OTP_ENDPOINT` overrides the admin value within config but
does not replace selected-service resolution. Disable the matching local service
and recreate API when switching these adapters to external instances.

Configure participation and credentials at `/admin/integrations`. See
[Public transit](../features/public-transit.md#configuring-transit) for the chain.

## Verifying it works

On the Docker host, check MOTIS liveness and queries within loaded coverage:

```bash
curl --fail --silent --show-error http://localhost:8081/api/v1/health
curl --fail --silent --show-error \
  'http://localhost:8081/api/v1/map/stops?min=52.51,13.36&max=52.54,13.38' | jq 'length'
curl --fail --silent --show-error \
  'http://localhost:8081/api/v1/geocode?text=Berlin+Hbf' | jq '.[0].name'
curl --fail --silent --show-error \
  'http://localhost:8081/api/v1/plan?fromPlace=52.525,13.369&toPlace=48.140,11.558' \
  | jq '.itineraries | length'
```

Health can answer before the timetable is queryable. Empty stops or plans can
also reflect geography or schedule dates, so use a known stop and a currently
operating trip. Static timetables use the stop's local day; route-pattern IDs
belong to the active dataset epoch and must not survive promotion.

For OTP, check the same GraphQL surface OpenMapX uses:

```bash
curl --fail --silent --show-error http://localhost:8090/otp/gtfs/v1 \
  -H 'Content-Type: application/json' \
  -d '{"query":"query OtpReadiness { __typename }"}'
```

A response with `data.__typename` confirms GraphQL reachability, not a usable
transit plan. Plan a known journey in OpenMapX, check itinerary attribution and
OTP logs, and verify that the chosen route is transit rather than a walking-only
fallback. OpenMapX does not use the retired REST-v1 plan example or the old
`/otp/routers/default/index/graphql` endpoint.

## See also

- [Preparing data](../install/preparing-data.md) for source and artifact handling.
- [MOTIS operations profiles](../administration/motis-operations-profiles.md) for
  preflight, retained slots, sovereignty, and recovery.
- [Requirements](../install/requirements.md) for host and build capacity.
- [Public transit](../features/public-transit.md) for rider behavior.
