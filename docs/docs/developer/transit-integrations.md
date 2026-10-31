---
title: Transit integrations
description: "Implement TransitProvider or RealtimeProvider with role-based selection, coverage, captured contributors and host-owned acquisition."
sidebar_position: 7
---

# Transit integrations

Transit integrations connect a schedule API, journey planner or realtime feed to
the transit orchestrator. Implement `TransitProvider` for stops, schedules and
planning, or `RealtimeProvider` for live vehicles, alerts and trip deltas.

Before adding one, read the [integration system](./integration-system.md) and
set up a [built-in integration](./writing-an-integration.md). The runtime
contracts in this page apply to trusted in-tree code. Installed community
artifacts cannot register providers in the API process.

The [Public transit](../features/public-transit.md) feature guide describes the
resulting user experience and available providers.

## The transit domain and the MOTIS-first chain

The orchestrator selects providers using geographic coverage, policy, health,
operation role and numeric priority. The self-hosted MOTIS provider supplies the
baseline when configured and healthy. Its actual coverage depends on the active
dataset. Without a local MOTIS endpoint, the integration registers hosted
Transitous as the baseline; with a local endpoint, Transitous has the fallback
role. Regional and enrichment providers retain their own roles. A regional
provider does not replace a healthy baseline merely by using a lower priority
number.

See [How the orchestrator picks a provider](#how-the-orchestrator-picks-a-provider)
for the dispatch rules. The configured provider list and user-facing behavior
are covered in [Public transit](../features/public-transit.md#how-the-orchestrator-works).

Two domains carry transit providers:

- **`transit`**: the `TransitProvider` contract. Stops, departures and
  arrivals, routes, journey planning, vehicle positions, and alerts. Registered
  with `ctx.registerTransitProvider(...)` and consumed by the transit
  orchestrator.
- **`live-transit`**: the `RealtimeProvider` contract. Real-time overlays:
  vehicle positions, service alerts, and per-trip update deltas that enrich
  scheduled departures. Registered with `ctx.registerRealtimeProvider(...)`.

An integration declares which it serves in the manifest's `domains` array; many
agencies ship both as two integrations (for example `transit-entur` and
`live-transit-entur`).

## The `TransitProvider` contract

The contract is defined in
`packages/integration-framework/src/contracts/transit-provider.ts`. A provider is
a plain object with seven required descriptor fields and a set of optional
methods:

```ts
interface TransitProvider {
  readonly id: string;
  readonly prefix: string;
  readonly coverage: { bbox: BBox } | { all: true };
  readonly priority: number;
  readonly role: "baseline" | "fallback" | "enrichment" | "regional";
  readonly capabilities: TransitCapabilities;
  readonly planningMetadata?: TransitPlanningMetadata;
  readonly attribution: Attribution[];

  // …optional methods, all returning Promise<MobilityResult<T>>
}
```

### Descriptor fields

- **`id`**: a stable provider identifier, conventionally the same as the
  integration id (`"transit-mbta"`). It names the provider in health tracking,
  metrics, and the operator's data-use policy.
- **`prefix`**: a short, colon-terminated namespace stamped onto every id this
  provider emits (`"mb:"`, `"myr:"`). Stops, routes, and trips come back as
  `mb:70061`. The orchestrator routes a by-id lookup straight back to the
  provider whose prefix the id starts with, so prefixes must be unique to one
  provider in practice.
- **`coverage`**: either `{ bbox: [minLng, minLat, maxLng, maxLat] }` or
  `{ all: true }`. The bbox is the geographic envelope the provider can answer
  for; `{ all: true }` makes it eligible for every request (MOTIS and the global
  catalogs use this). Keep a regional bbox tight: wide envelopes make it eligible
  for requests outside its useful coverage.
- **`role`** determines operation policy. Spatial selection orders `baseline`,
  `regional`, `fallback`, then `enrichment`. A successful empty baseline plan
  is authoritative and stops the planning waterfall.
- **`priority`** sorts providers within the same role for spatial selection;
  lower values run first, with provider ID as the final tie-breaker. Prefix
  lookup sorts by priority.
- **`planningMetadata`** optionally identifies the planner's `source`, `instance`,
  `datasetEpoch` and supported `rentalFormFactors`. Keep these tied to the active
  dataset so rental filters and refresh requests cannot use stale identities.
- **`capabilities`**: a `TransitCapabilities` object declaring which optional
  methods you actually implement (below).
- **`attribution`**: an `Attribution[]` for the feeds this provider
  redistributes, normally produced from the manifest's `dataSources` (see
  [Attribution and freshness](#attribution-and-freshness)).

### Capabilities

Capability flags describe the supported surface and must agree with the
methods you ship. Consumers also check method presence and request-specific
planning features. The capability shape is nested:

```ts
interface TransitCapabilities {
  stops: {
    lookup: boolean; // getStop
    nearby: boolean; // getStopsNearby
    bbox: boolean; // getStopsInBbox
    search: boolean; // searchStopsByName
    infrastructure: boolean; // getStopInfrastructure
    platforms: boolean; // getStopPlatforms
    timetable: boolean; // getStopTimetable
  };
  departures: boolean; // getDepartures
  arrivals: boolean; // getArrivals
  routes: {
    lookup: boolean; // getRoute
    forStop: boolean; // getRoutesForStop
    stops: boolean; // getRouteStops
    geometry: boolean; // getLegGeometry
  };
  planning: boolean; // planTrip
  planningFeatures?: TransitPlanningCapabilities;
  vehiclePositions: boolean; // getVehiclePositions / getVehicleRadar
  vehicleJourney: boolean; // getVehicleJourney
  alerts: {
    byStop: boolean; // getAlertsForStop
    byRoute: boolean; // getAlertsForRoute
    byBbox: boolean; // getAlertsForBbox
  };
  facilities: boolean; // getFacilities
  reachability?: { estimatedSurface: boolean; exactPointChecks: boolean };
}
```

Set a flag `true` only when you ship the matching method **and** the upstream can
answer it for your coverage area. Set it `false` when you don't ship
the method, or when the upstream answers but returns degenerate data (placeholder
arrays, "not implemented"): a `false` flag keeps the orchestrator from spending
a round-trip on a method that can't help.

Planning features are explicit. `TransitPlanningCapabilities` contains
`maxTransfers`, `transferBuffer`, `wheelchairRequired`, `bikeTransport`,
`elevation`, `rentalFilters`, `detailedTransfers`, `paging` and `refresh` booleans,
with optional `chaining` and `temporal`. Missing advanced flags mean unsupported.
The orchestrator filters planners against the requested constraints and reports
unsupported combinations instead of silently weakening them.

A normal successful empty query is valid. Leave a capability enabled when the
upstream supports it but has no matching data; disable it for an unimplemented
operation.

Throw when the upstream fails: a network error, an error status or a malformed
body. Don't return an empty list for a failure. An empty result means "nothing
here", so the board would show "No departures" or no lines, and caches would keep
it. The orchestrator turns a thrown error into a partial or failed board and
records it in provider health. Keep thrown messages generic when request URLs
carry credentials.

### Methods

The data methods below are optional and return `MobilityResult<T>` so
attribution and freshness travel with the payload. Metadata and health methods
have their separate return types. The data surface is grouped by purpose:

```ts
// Stops
getStop?(id): Promise<MobilityResult<TransitStop | null>>;
getStopsNearby?(lat, lng, radiusMeters): Promise<MobilityResult<TransitStop[]>>;
getStopsInBbox?(bbox): Promise<MobilityResult<TransitStop[]>>;
searchStopsByName?(q, limit?, context?: ProviderCallContext): Promise<MobilityResult<TransitStop[]>>;
getStopInfrastructure?(stopId): Promise<MobilityResult<TransitStopInfrastructure | null>>;
getStopPlatforms?(stopId): Promise<MobilityResult<TransitStop[]>>;
getStopTimetable?(stopId, date): Promise<MobilityResult<TimetableEntry[]>>;
getStopTransfers?(stopId): Promise<MobilityResult<StopTransfer[]>>;

// Departures / arrivals (arrivals reuse the Departure shape)
getDepartures?(stopId, minutes): Promise<MobilityResult<Departure[]>>;
getArrivals?(stopId, minutes): Promise<MobilityResult<Departure[]>>;

// Routes / lines
getRoute?(routeId): Promise<MobilityResult<TransitRoute | null>>;
getRouteStops?(routeId, hintStopId?): Promise<MobilityResult<TransitStop[]>>;
getRoutesForStop?(stopId): Promise<MobilityResult<TransitRoute[]>>;
getLegGeometry?(tripId, fromStopId?, toStopId?): Promise<MobilityResult<LineString | null>>;

// Journey planning + vehicles
planTrip?(opts: TripPlanRequest): Promise<MobilityResult<TripPlan[]>>;
refreshTrip?(opts: TripRefreshRequest): Promise<MobilityResult<TripItinerary | null>>;
getVehicleJourney?(tripId, fallbackIds?): Promise<MobilityResult<VehicleJourney | null>>;
getVehiclePositions?(routeId): Promise<MobilityResult<VehiclePosition[]>>;
getVehicleRadar?(bbox): Promise<MobilityResult<VehiclePosition[]>>;

// Alerts + facilities
getAlertsForStop?(stopId): Promise<MobilityResult<ServiceAlert[]>>;
getAlertsForRoute?(routeId): Promise<MobilityResult<ServiceAlert[]>>;
getAlertsForBbox?(bbox): Promise<MobilityResult<ServiceAlert[]>>;
getFacilities?(stopId): Promise<MobilityResult<Facility[]>>;
```

Calendar arguments such as the `date` passed to `getStopTimetable` represent the
stop's **local civil day**. Do not reinterpret the date as a UTC midnight range;
the provider must query the upstream using the stop/region timezone and return
that complete local service day.

Provider IDs are opaque. In particular, MOTIS route-pattern IDs encode the
active dataset epoch so an ID from one promotion is rejected after the next.
They are request-routing handles, not durable external identifiers: reacquire a
pattern from `getRoutesForStop` or `getRoutesInBbox` after a dataset change.
MOTIS pattern details and geometry use the experimental
`/api/experimental/map/route-details` endpoint of the repository-pinned MOTIS
version, so a pin upgrade must rerun the adapter contract and promotion canaries.

The canonical model types (`TransitStop`, `Departure`, `TransitRoute`,
`TripPlan`, `VehiclePosition` and `ServiceAlert`) come from
`@openmapx/mobility-core/transit`. Map your upstream's response into these shapes;
don't invent your own. `planTrip` takes a `TripPlanRequest` that already mirrors
the routing engine's knobs (mode allow-list, wheelchair routing, first- and
last-mile access modes), so a planning provider can pass them through rather than
re-deriving them.

`getRoutesInBbox` and `getStopTransfers` remain optional methods outside the
base capability flags. `refreshTrip` is advertised through
`planningFeatures.refresh`. Transit reachability uses a separate contract because an estimated seed
surface and an exact destination check have different accuracy, privacy, and
runtime requirements:

```ts
getReachabilityCapabilities?(): Promise<TransitReachabilityCapabilities>;
getTransitTravelTimeField?(
  request: TransitIsochroneRequest,
  signal?: AbortSignal,
): Promise<MobilityResult<TravelTimeField>>;
getReachabilitySurface?(
  request: TransitReachabilitySurfaceRequest,
  signal?: AbortSignal,
): Promise<MobilityResult<TransitReachabilitySurface>>;
checkReachabilityDestinations?(
  request: TransitReachabilityCheckRequest,
  signal?: AbortSignal,
): Promise<MobilityResult<TransitReachabilityCheckResult>>;
```

The surface may fall back to Transitous and contains one-to-all stop seeds for
an explicitly estimated client-rendered field. Exact destination checks must be
capability-gated and self-hosted; never forward arbitrary destination batches to
Transitous. See [Transit reachability](../administration/transit-reachability.md)
for the operational contract.

### Per-feed attribution

When one integration fronts many feeds, each with its own license, implement `getFeedAttribution()`:

```ts
getFeedAttribution?(): Promise<Record<string, ProviderAttribution>>;
```

The keys must match the exact feed identities your records carry. Capture that
lookup before acquisition, then stamp each stop/departure/journey/alert with its
own canonical `contributors` before caching or merging. Current frontend
registry metadata must not rewrite old records. A proven uniform supplier can
stamp its single-source receipt at the adapter boundary; a heterogeneous MOTIS
result needs actual per-item feed evidence. Missing/unknown feeds cannot inherit
all provider credits. Keep required notices and explicit canonical parent source
identity alongside each receipt.

## How the orchestrator picks a provider

The transit orchestrator (`integrations/transit/orchestrator.ts`) collects every
registered `transit` provider via `ctx.getIntegrationsByDomain("transit")` and
selects among them with two strategies, depending on the request:

- **By id (prefix routing).** For a lookup keyed on a single ID (`getStop`,
  `getRoute` or a trip update), the orchestrator sorts providers by priority and
  returns the first whose `prefix` the id starts with and that is currently
  healthy. Because the id already encodes its origin (`mb:70061`), this dispatches
  straight back to the provider that minted it.
- **By area (bbox + priority).** For a spatial request (stops near a point, a
  journey plan, vehicles in view or area alerts), the orchestrator keeps
  every provider whose `coverage` overlaps the request bbox (`{ all: true }`
  always overlaps), then sorts by role, priority and ID. For a **journey plan** it
  filters by requested planning capabilities, tries eligible providers in that
  order and returns the first usable plan. A healthy baseline returning an empty
  plan stops the waterfall. A failed baseline call can fall through; emptiness
  from a non-baseline provider can also continue. For **fan-out** queries (stops in an area,
  vehicle radar, area alerts) it queries the matching providers in parallel and
  merges, de-duplicating stops that appear in more than one feed.

Coverage overlap is a plain rectangle-intersection test, so a tight `coverage.bbox`
scopes a provider out of unrelated requests. Provider calls are timed and recorded in the host health tracker. Counted
failures can open its circuit; eligible half-open probes allow recovery. Valid
empty results, input/policy rejection, quota denial and caller cancellation must
not count as upstream failures.

## The `RealtimeProvider` contract

Real-time providers live in the `live-transit` domain and implement a smaller
contract from
`packages/integration-framework/src/contracts/realtime-provider.ts`:

```ts
interface RealtimeProvider {
  readonly id: string;
  readonly coverage: { bbox: BBox } | { all: true };
  readonly priority: number;
  readonly capabilities: RealtimeCapabilities;
  readonly attribution: Attribution[];

  getVehiclePositions?(bbox): Promise<MobilityResult<LiveTransitVehicle[]>>;
  getAlertsForStop?(stopId): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForRoute?(routeId): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForBbox?(bbox): Promise<MobilityResult<ServiceAlert[]>>;
  getTripUpdate?(tripId, stopId?): Promise<MobilityResult<TripUpdate | null>>;
  getTripUpdates?(tripIds, stopId?): Promise<MobilityResult<Record<string, TripUpdate | null>>>;
  healthCheck?(): Promise<HealthCheckResult>;
}
```

Its `capabilities` flags are `vehiclePositions`, `tripUpdates`, and the same
nested `alerts` group (`byStop` / `byRoute` / `byBbox`).

The central method is `getTripUpdate`. The orchestrator enriches scheduled
departures by walking the registered real-time providers (priority ascending,
filtered to those whose coverage overlaps the area) and asking each to resolve a
delta for a `(tripId, stopId)` pair. A `TripUpdate` carries the live
`expectedAt`, a signed `delaySeconds`, a `canceled` flag, and an optional
`platform` override. **Return an envelope with `data: null` when you cannot resolve the trip**, typically
because the ID prefix is unknown, so the orchestrator moves on to
the next provider without a thrown error path or a wasted round-trip.

When the underlying schedule provider already returns real-time-aware times (MOTIS
does this natively from GTFS-RT), the orchestrator skips the redundant
enrichment pass, so a real-time provider only does work that adds something.

## The provider factory

The framework offers shared attribution storage and response wrappers through `defineTransitProvider()`, exported from
`@openmapx/integration-framework`:

```ts
const { attribution, wrap, wrapRT, init } = defineTransitProvider();
```

- **`init(ctx)`** schedules the attribution-store update with `ctx.onActivate`.
  It runs immediately on initial startup and is deferred until activation on
  reload. Do not read it during staging to capture a new generation's receipts;
  capture those directly from `ctx` before acquisition.
- **`attribution.all()`**: the resolved `Attribution[]` to put on the provider.
- **`wrap(data, sourceIds?)` / `wrapRT(data, sourceIds?)`**: retain captured
  record contributors and derive envelope credits from those records, with a
  freshness stamp. The optional IDs narrow declared metadata for an explicitly
  known acquisition. Uniform single-source legacy payloads have a compatibility
  boundary; a multi-source manifest cannot prove an untagged item's supplier.
  Capture metadata before the upstream await and stamp returned records before
  caching; a wrapping call after acquisition cannot capture the old metadata. `wrapRT` sets
  `hasRealtimeData: true`. Use it only when the response contains realtime
  evidence. A scheduled departure, empty result or static alert does not become
  realtime because of its method name.

The factory supplies attribution storage and result wrapping. It does not own
HTTP transport, credentials, quota admission, source policy or request lifetime.
New adapters should keep those dependencies local to a setup generation, as in
the MBTA example below. A post-acquisition wrapper cannot repair metadata that
was not captured before the request.

### Attribution and freshness

Provider code should not hand-roll `Attribution` objects. Declaring upstream
licenses in the manifest's `dataSources` gives the adapter canonical metadata
for acquisition-time receipts. Each `dataSources` entry needs a globally unique
`sourceId`. Preserve per-item/per-feed `contributors`, including distinct
mandatory notices, through caches, realtime application, merged records,
pagination and DTOs. A supplied `[]` stops fallback. Discarded duplicates and
no-op realtime deltas contribute nothing; actually applied fields keep their
own suppliers. Boards credit displayed tab/mode rows and represented alerts,
while selected itinerary details and core map geometry use their own captured
receipts. The [captured contract](./integration-system.md#captured-contributor-contract)
explains exact resolution and field/container ownership. See the
[integration system](./integration-system.md#data-sources) reference for the full
`dataSources` field list and the completeness gate that enforces it.

## Registering a provider

A transit integration's backend entry point is small: configure the upstream
client, then register the provider object. The host calls `setup(ctx)` once at
load time.

```ts
import {
  captureTransitContributors,
  type IntegrationContext,
  resolveIntegrationContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { transitDataContributors } from "@openmapx/mobility-core/transit-contributors";
import { createMbtaClient } from "./client";
import { MbtaError } from "./errors";
import { createMbtaProvider } from "./provider";

export function setup(ctx: IntegrationContext): void {
  const generation = new AbortController();
  const receipts = snapshotContributors(resolveIntegrationContributors(ctx, ["mbta"]));
  const client = createMbtaClient({
    http: ctx.http,
    upstreamRuntime: ctx.upstreamRuntime,
    apiKey: typeof ctx.config.apiKey === "string" ? ctx.config.apiKey : undefined,
    signal: generation.signal,
    isSourceAllowed: async () => {
      const denied = await ctx.getDisallowedSourceIds?.();
      return !denied?.has("mbta") && !denied?.has(ctx.id);
    },
  });
  const mbta = createMbtaProvider(client);
  ctx.onShutdown(async () => {
    generation.abort();
  });
  const result = async <T>(acquire: () => Promise<T>, realtime = false) => {
    const captured = snapshotContributors(receipts);
    const data = await acquire();
    if (generation.signal.aborted) throw new MbtaError("cancelled");
    if (client.configured) await client.assertAvailable();
    if (generation.signal.aborted) throw new MbtaError("cancelled");
    const credited = captureTransitContributors(data, captured);
    return withAttribution(
      credited,
      transitDataContributors(credited),
      freshnessNow({ hasRealtimeData: realtime }),
    );
  };
  const wrap = <T>(acquire: () => Promise<T>) => result(acquire);
  const wrapRT = <T>(acquire: () => Promise<T>) => result(acquire, true);
  ctx.registerHealthCheck(async () => {
    if (generation.signal.aborted) return { status: "down", error: "MBTA instance retired" };
    if (!client.configured) return { status: "unconfigured", error: "MBTA API key not configured" };
    try {
      await mbta.probe();
      if (generation.signal.aborted) throw new MbtaError("cancelled");
      return { status: "up" };
    } catch (error) {
      return {
        status: "down",
        error: error instanceof MbtaError ? error.message : "MBTA probe failed",
      };
    }
  });
  ctx.registerTransitProvider({
    id: "transit-mbta",
    prefix: "mb:",
    coverage: { bbox: [-71.9, 41.3, -69.9, 42.9] },
    priority: 1,
    role: "enrichment",
    attribution: receipts,
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: false,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehiclePositions: true,
      vehicleJourney: false,
      alerts: { byStop: true, byRoute: true, byBbox: false },
      facilities: true,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(() => mbta.getStops(lat, lng, radiusMeters));
    },
    async getStop(id) {
      return wrap(() => mbta.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(() => mbta.getDepartures(id, min));
    },
    async getVehiclePositions(routeId) {
      return wrapRT(() => mbta.getVehiclePositions(routeId));
    },
    async getFacilities(stopId) {
      return wrap(() => mbta.getFacilities(stopId));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(() => mbta.getAlerts({ stopId }));
    },
    async getAlertsForRoute(routeId) {
      return wrapRT(() => mbta.getAlerts({ routeId }));
    },
  });
}
```

This is `integrations/transit-mbta/index.ts`. `createMbtaClient` receives host
HTTP, shared upstream admission, credentials, source policy and a generation
signal. `createMbtaProvider(client)` owns mapping. Neither is a framework export;
both are local modules in that integration.

The result helper captures receipts before awaiting, rechecks availability and
retirement before publication, and wraps mapped records with their credits.
The provider declares `role: "enrichment"` and a regional bbox. Its custom health
check reports a missing key as `unconfigured`. Shutdown aborts the generation.
The example uses realtime wrapping for the adapter's departures, positions and
alerts; preserve actual freshness semantics when adapting it to another API.

Registering a real-time provider follows the same pattern against
`ctx.registerRealtimeProvider(...)`. A provider that has a meaningful self-check
can implement `healthCheck()` on the contract; thin pass-throughs can omit it and
declare `ctx.registerHealthCheck(...)` at setup instead, or rely on the manifest's
`healthCheck` probe.

:::tip[Keep the capability bitmap honest]
A capability flag set `true` requires the matching method. The
`assertTransitProviderContract` and `assertRealtimeProviderContract` helpers
check that relationship, and the repository's provider conformance suite runs
against real integration setup functions. Assert that each advertised
operation is implemented and that its fixture output satisfies the contract.
Optional methods outside the base flags remain explicit on the interface.
:::

## Manifest essentials

A transit provider's manifest is an ordinary integration manifest with
`"domains": ["transit"]` (or `["live-transit"]`). The fields that matter most
here:

- **`dataSources`**: one entry per upstream feed, each with a unique `sourceId`,
  the license, and privacy metadata. This is where attribution comes from.
- **`configSchema`**: declare an `endpoint` and any `apiKey` (mark a key
  `"x-openmapx-secret": true` so it's handled as a credential).
- **`healthCheck`**: an HTTP probe against the upstream's status endpoint, with
  `${configKey}` interpolation when the probe needs a key.

The manifest schema, the config cascade, and the loader lifecycle are shared
across all integrations and documented on the
[integration system](./integration-system.md) page; the
[service manifest](./service-manifest.md) reference covers the separate
backend-service side (running your own MOTIS or OpenTripPlanner) that a transit
provider points at.

## Verify an adapter

Use a mock `IntegrationContext` and fixture responses through the host HTTP
client. Cover the methods you advertise, mapper output, exact source receipts,
policy exclusion, cancellation, missing credentials and shutdown during an
in-flight request. Test the planning role and advanced constraints through the
orchestrator when adding planning support.

Keep generated upstream clients behind the adapter's transport boundary. Entur
uses its private [native Geocoder SDK](./entur-geocoder.md); OTP uses the
repository's generated GraphQL client. Regenerate from their committed snapshots
and run the corresponding focused checks when their contracts change. Do not
hand-edit generated operations or add a separate network fallback.

A fixture test does not establish live agency coverage, current provider
credentials or MOTIS promotion readiness. Record those runtime checks separately.
