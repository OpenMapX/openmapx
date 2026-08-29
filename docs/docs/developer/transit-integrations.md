---
title: Transit integrations
description: Writing a transit or real-time provider — the TransitProvider and RealtimeProvider contracts, priority and coverage routing, the provider factory, and a worked agency example.
sidebar_position: 7
---

# Transit integrations

A **transit integration** contributes a provider to OpenMapX's public-transit
chain: a national operator's API, a self-hosted engine, or a real-time vehicle
feed. This page is the contract-level guide to writing one. It
assumes you have read the [integration system](./integration-system.md)
reference — the manifest, the `IntegrationContext`, and the loader lifecycle all
apply here unchanged — and covers the two contracts unique to transit:
`TransitProvider` (schedules, stops, journey planning) and `RealtimeProvider`
(live deltas, vehicle positions, alerts).

For the user-facing picture of what these providers add up to — journey
planning, departure boards, route options, live vehicles — see
[Public transit](../features/public-transit.md). This page is the other side of
that feature: how a provider plugs into the orchestrator that powers it.

## The transit domain and the MOTIS-first chain

No single data source covers the world's transit well, so OpenMapX runs a
**chain of providers**. Each one declares the geographic area it covers and a
numeric priority, and a transit orchestrator dispatches to them in order. The
model is **MOTIS-first**: a self-hosted [MOTIS](https://github.com/motis-project/motis)
instance with worldwide coverage sits at the top, regional and agency providers
slot in just below it where they add value, and broad catalogs sit underneath as
a long-tail fallback. The full chain and its priority tiers are documented on the
[Public transit](../features/public-transit.md#how-the-orchestrator-works)
feature page; this guide focuses on the contract your provider implements to join
it.

Two domains carry transit providers:

- **`transit`** — the `TransitProvider` contract. Stops, departures and
  arrivals, routes, journey planning, vehicle positions, and alerts. Registered
  with `ctx.registerTransitProvider(...)` and consumed by the transit
  orchestrator.
- **`live-transit`** — the `RealtimeProvider` contract. Real-time overlays:
  vehicle positions, service alerts, and per-trip update deltas that enrich
  scheduled departures. Registered with `ctx.registerRealtimeProvider(...)`.

An integration declares which it serves in the manifest's `domains` array; many
agencies ship both as two integrations (for example `transit-entur` and
`live-transit-entur`).

## The `TransitProvider` contract

The contract is defined in
`packages/integration-framework/src/contracts/transit-provider.ts`. A provider is
a plain object with five required descriptor fields and a set of optional
methods:

```ts
interface TransitProvider {
  readonly id: string;
  readonly prefix: string;
  readonly coverage: { bbox: BBox } | { all: true };
  readonly priority: number;
  readonly capabilities: TransitCapabilities;
  readonly attribution: Attribution[];

  // …optional methods, all returning Promise<MobilityResult<T>>
}
```

### Descriptor fields

- **`id`** — a stable provider identifier, conventionally the same as the
  integration id (`"transit-mbta"`). It names the provider in health tracking,
  metrics, and the operator's data-use policy.
- **`prefix`** — a short, colon-terminated namespace stamped onto every id this
  provider emits (`"mb:"`, `"myr:"`). Stops, routes, and trips come back as
  `mb:70061`. The orchestrator routes a by-id lookup straight back to the
  provider whose prefix the id starts with, so prefixes must be unique to one
  provider in practice.
- **`coverage`** — either `{ bbox: [minLng, minLat, maxLng, maxLat] }` or
  `{ all: true }`. The bbox is the geographic envelope the provider can answer
  for; `{ all: true }` makes it eligible for every request (MOTIS and the global
  catalogs use this). Keep a regional bbox tight — wide envelopes pull a provider
  into requests it can't usefully serve and add noise to result de-duplication.
- **`priority`** — a number, **lower wins**. It positions the provider in the
  chain. The priority bands (1 for the backbone and tight regional providers,
  5 for catalogs, 7 for the always-on soft fallback, and so on) are listed on the
  [feature page](../features/public-transit.md#how-the-orchestrator-works); match
  the band that fits your provider's role.
- **`capabilities`** — a `TransitCapabilities` object declaring which optional
  methods you actually implement (below).
- **`attribution`** — an `Attribution[]` for the feeds this provider
  redistributes, normally produced from the manifest's `dataSources` (see
  [Attribution and freshness](#attribution-and-freshness)).

### Capabilities

The orchestrator dispatches on the declared `capabilities` object rather than
probing methods at runtime, so the capability flags and the methods you ship must
agree. The shape is nested:

```ts
interface TransitCapabilities {
  stops: {
    lookup: boolean;        // getStop
    nearby: boolean;        // getStopsNearby
    bbox: boolean;          // getStopsInBbox
    search: boolean;        // searchStopsByName
    infrastructure: boolean; // getStopInfrastructure
    platforms: boolean;     // getStopPlatforms
    timetable: boolean;     // getStopTimetable
  };
  departures: boolean;      // getDepartures
  arrivals: boolean;        // getArrivals
  routes: {
    lookup: boolean;        // getRoute
    forStop: boolean;       // getRoutesForStop
    stops: boolean;         // getRouteStops
    geometry: boolean;      // getLegGeometry
  };
  planning: boolean;        // planTrip
  vehiclePositions: boolean; // getVehiclePositions / getVehicleRadar
  vehicleJourney: boolean;  // getVehicleJourney
  alerts: {
    byStop: boolean;        // getAlertsForStop
    byRoute: boolean;       // getAlertsForRoute
    byBbox: boolean;        // getAlertsForBbox
  };
  facilities: boolean;      // getFacilities
}
```

Set a flag `true` only when you ship the matching method **and** the upstream can
genuinely answer it for your coverage area. Set it `false` when you don't ship
the method, or when the upstream answers but returns degenerate data (empty
arrays, "not implemented") — a `false` flag keeps the orchestrator from spending
a round-trip on a method that can't help.

### Methods

Every method is optional, and every one returns its payload wrapped in a
`MobilityResult<T>` so attribution and freshness travel with the data. The full
surface, grouped by what it answers:

```ts
// Stops
getStop?(id): Promise<MobilityResult<TransitStop | null>>;
getStopsNearby?(lat, lng, radiusMeters): Promise<MobilityResult<TransitStop[]>>;
getStopsInBbox?(bbox): Promise<MobilityResult<TransitStop[]>>;
searchStopsByName?(q, limit?): Promise<MobilityResult<TransitStop[]>>;
getStopInfrastructure?(stopId): Promise<MobilityResult<TransitStopInfrastructure | null>>;
getStopPlatforms?(stopId): Promise<MobilityResult<TransitStop[]>>;
getStopTimetable?(stopId, date): Promise<MobilityResult<TimetableEntry[]>>;

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

The canonical model types — `TransitStop`, `Departure`, `TransitRoute`,
`TripPlan`, `VehiclePosition`, `ServiceAlert`, and friends — come from
`@openmapx/mobility-core/transit`. Map your upstream's response into these shapes;
don't invent your own. `planTrip` takes a `TripPlanRequest` that already mirrors
the routing engine's knobs (mode allow-list, wheelchair routing, first- and
last-mile access modes), so a planning provider can pass them through rather than
re-deriving them.

`getRoutesInBbox` remains an optional method outside the declared capability
set. Transit reachability uses a separate contract because an estimated seed
surface and an exact destination check have different accuracy, privacy, and
runtime requirements:

```ts
getReachabilityCapabilities?(): Promise<TransitReachabilityCapabilities>;
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

When one integration fronts many feeds, each with its own license — for example
a registry wrapping dozens of agency APIs or the MOTIS dataset assembled from
many declared sources — implement `getFeedAttribution()`:

```ts
getFeedAttribution?(): Promise<Record<string, ProviderAttribution>>;
```

The keys must match what your results carry on `TransitStop.provider`,
`VehicleJourney.provider`, and `ServiceAlert.providers[]`, so the frontend can
resolve the right license chip per result. A single-license provider doesn't need
this — its `attribution` array is enough.

## How the orchestrator picks a provider

The transit orchestrator (`integrations/transit/orchestrator.ts`) collects every
registered `transit` provider via `ctx.getIntegrationsByDomain("transit")` and
selects among them with two strategies, depending on the request:

- **By id (prefix routing).** For a lookup keyed on a single id — `getStop`,
  `getRoute`, a trip update — the orchestrator sorts providers by priority and
  returns the first whose `prefix` the id starts with and that is currently
  healthy. Because the id already encodes its origin (`mb:70061`), this dispatches
  straight back to the provider that minted it.
- **By area (bbox + priority).** For a spatial request — stops near a point, a
  journey plan, vehicles in view, alerts for an area — the orchestrator keeps
  every provider whose `coverage` overlaps the request bbox (`{ all: true }`
  always overlaps), then sorts by priority ascending. For a **journey plan** it
  waterfalls: it tries each matching provider in priority order and returns the
  first that yields a usable itinerary. For **fan-out** queries (stops in an area,
  vehicle radar, area alerts) it queries the matching providers in parallel and
  merges, de-duplicating stops that appear in more than one feed.

Coverage overlap is a plain rectangle-intersection test, so a tight `coverage.bbox`
genuinely scopes a provider out of unrelated requests. Every provider call is also
timed and recorded into a sliding health window — a provider that starts failing
is taken out of rotation for a short cooldown and recovers on its own, so one
flaky upstream degrades to the next in the chain rather than failing the request.

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

  getVehiclePositions?(bbox): Promise<MobilityResult<VehiclePosition[]>>;
  getAlertsForStop?(stopId): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForRoute?(routeId): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForBbox?(bbox): Promise<MobilityResult<ServiceAlert[]>>;
  getTripUpdate?(tripId, stopId?): Promise<MobilityResult<TripUpdate | null>>;
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
`platform` override. **Return `null` when you can't resolve the trip** — typically
because the id prefix isn't one you recognize — so the orchestrator moves on to
the next provider without a thrown error path or a wasted round-trip.

When the underlying schedule provider already returns real-time-aware times (MOTIS
does this natively from GTFS-RT), the orchestrator skips the redundant
enrichment pass, so a real-time provider only does work that adds something.

## The provider factory

Every transit integration repeats the same attribution-and-wrapping boilerplate.
The framework factors it into `defineTransitProvider()`, exported from
`@openmapx/integration-framework`:

```ts
const { attribution, wrap, wrapRT, init } = defineTransitProvider();
```

- **`init(ctx)`** — call once at the top of `setup`; it loads the attribution
  store from `ctx.manifest.dataSources`.
- **`attribution.all()`** — the resolved `Attribution[]` to put on the provider.
- **`wrap(data)` / `wrapRT(data)`** — tag a payload with that attribution and a
  freshness stamp, producing the `MobilityResult<T>` every method must return.
  `wrapRT` is the same but flips the `hasRealtimeData` flag — use it for
  departures, vehicle positions, and alerts; use `wrap` for static stops and
  routes.

Everything that genuinely differs between providers stays explicit in `setup` —
the `id`, `prefix`, `coverage`, `priority`, the `capabilities` object, any
config wiring, and the method delegations. The factory only removes the parts
that are identical across the board.

### Attribution and freshness

Provider code should not hand-roll `Attribution` objects. Declaring upstream
licenses in the manifest's `dataSources` and letting `defineTransitProvider()`
turn them into the attribution shape keeps credit metadata in one place — where
the legal pages and per-result credit chips also read it. Each `dataSources` entry
needs a globally unique `sourceId`; results are tagged with that id, and the host
maps it back to the right license. See the
[integration system](./integration-system.md#data-sources) reference for the full
`dataSources` field list and the completeness gate that enforces it.

## Registering a provider

A transit integration's backend entry point is small: configure the upstream
client, then register the provider object. The host calls `setup(ctx)` once at
load time.

```ts
import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as mbta from "./provider.js";

const { attribution, wrap, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  mbta.setMbtaApiKey(ctx.config.apiKey as string | undefined);

  ctx.registerTransitProvider({
    id: "transit-mbta",
    prefix: "mb:",
    coverage: { bbox: [-71.9, 41.3, -69.9, 42.9] },
    priority: 1,
    attribution: attribution.all(),
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
      return wrap(await mbta.getStops(lat, lng, radiusMeters));
    },
    async getStop(id) {
      return wrap(await mbta.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(await mbta.getDepartures(id, min));
    },
    async getVehiclePositions(routeId) {
      return wrapRT(await mbta.getVehiclePositions(routeId));
    },
    async getFacilities(stopId) {
      return wrap(await mbta.getFacilities(stopId));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(await mbta.getAlerts({ stopId }));
    },
    async getAlertsForRoute(routeId) {
      return wrapRT(await mbta.getAlerts({ routeId }));
    },
  });
}
```

This is the real `integrations/transit-mbta/index.ts`, lightly trimmed. Note the
shape it follows: a tight regional bbox, `priority: 1` for a precise agency
provider, `vehicleJourney` and `arrivals` left `false` because the upstream
doesn't model them, and the upstream HTTP itself kept in a separate
`provider.ts` of pure functions. The `wrap` / `wrapRT` split tracks which results
are real-time — departures, positions, and alerts use `wrapRT`; static stops and
facilities use `wrap`.

Registering a real-time provider follows the same pattern against
`ctx.registerRealtimeProvider(...)`. A provider that has a meaningful self-check
can implement `healthCheck()` on the contract; thin pass-throughs can omit it and
declare `ctx.registerHealthCheck(...)` at setup instead, or rely on the manifest's
`healthCheck` probe.

:::tip[Keep the capability bitmap honest]
The single most common contract bug is a capability flag set `true` with no
matching method, or a method shipped without flipping its flag. The orchestrator
dispatches on the flags, so a mismatch means either a method that never gets
called or a call that lands on `undefined`. Make the two agree, and let your
tests assert it.
:::

## Manifest essentials

A transit provider's manifest is an ordinary integration manifest with
`"domains": ["transit"]` (or `["live-transit"]`). The fields that matter most
here:

- **`dataSources`** — one entry per upstream feed, each with a unique `sourceId`,
  the license, and privacy metadata. This is where attribution comes from.
- **`configSchema`** — declare an `endpoint` and any `apiKey` (mark a key
  `"x-openmapx-secret": true` so it's handled as a credential).
- **`healthCheck`** — an HTTP probe against the upstream's status endpoint, with
  `${configKey}` interpolation when the probe needs a key.

The manifest schema, the config cascade, and the loader lifecycle are shared
across all integrations and documented on the
[integration system](./integration-system.md) page; the
[service manifest](./service-manifest.md) reference covers the separate
backend-service side (running your own MOTIS or OpenTripPlanner) that a transit
provider points at.
