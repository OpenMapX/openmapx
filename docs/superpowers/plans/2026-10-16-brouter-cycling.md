# BRouter cycling integration implementation plan

Spec: docs/superpowers/specs/2026-10-16-brouter-design.md

## Delivery prerequisite

Do not implement product code before the service commit is pushed and Germany
coverage is running and verified on DEORS-SRV-1. Planning and source investigation
may proceed while the service push checks run. Continue directly on main.

## Global constraints and decisions

Use IntegrationContext HTTP and existing provider fallback, attribution and source
policy. BRouter serves cycling only and is not implicitly pointed at a public
instance. Keep timed and optimized routes on compatible providers. Preserve bike
preferences in Valhalla fallback, route caches, shares and reroutes. Use three
user options: bike type (trekking/road/gravel/mountain), hill preference
(default/avoid/strongly-avoid), prefer quieter roads (boolean). Defaults are
upstream trekking behavior, default hill preference, quiet-road preference off.
Do not add a separate steps setting. The bundled gravel profile cannot honor the
existing ferry-avoidance flag: fall back to Valhalla for that combination rather
than silently ignoring it. Honor no-go points/polygons through BRouter's API.

### Task 1: Typed cycling options and request identities

Files: packages/core/src/types/routing.ts, routing/bicycleOptions.ts, routing/index.ts,
index.ts, api/directions.ts; integrations/routing/directions-request.ts,
schedule-request.ts; corresponding request/client tests.

Interfaces: BikeProfile = trekking|road|gravel|mountain; BikeHillPreference =
default|avoid|strongly-avoid. BikeRoutingOptions carries optional bikeProfile,
bikeHillPreference, bikePreferQuietRoads. Export constants and guards to avoid
independent enum lists. RoutingOptions, FetchDirectionsParams and scheduled/share
requests extend this contract. Cycling requests normalize defaults; non-cycling
requests omit bike fields. Validate explicit values and include effective values
in both ordinary and schedule cache identities.

- Write failing parser/identity tests for every enum, malformed flags, default
  cycling values, non-cycling isolation and distinct cache identities.
- Implement types and parsing, client serialization and focused tests.

### Task 2: Cycling-only provider and engine mapping

Files: new integrations/routing-brouter/{package.json,manifest.json,index.ts,
provider.ts,mapper.ts,provider.test.ts,mapper.test.ts,strings/en.json,strings/de.json,
__fixtures__/aachen.json}; routing-valhalla/provider.ts and tests; pnpm-lock.yaml.

Interfaces: createBrouterProvider(ctx, endpoint): RoutingProvider with priority 5,
cycling only, exclusions support, no time-aware/optimization claims. setup registers
only with a resolved service or configured operator endpoint. Convert a captured
GeoJSON response through mapBrouterRoute(raw, waypoints, options) into Route.

- Capture real service responses and write failing tests for registration,
  profile parameters, timeout/no-route failure, alternatives and exclusions.
- Map upstream trekking/fastbike/gravel/mtb profiles and their actual globals;
  quiet road mode uses fastbike-verylowtraffic for road bikes. Skip unsupported
  gravel + avoidFerries through a provider error so existing fallback runs.
- Normalize finite geometry/times/metrics, map documented numeric voicehint codes
  into localized OpenMapX maneuvers, include depart/arrive steps, retain roundabout
  exit counts, and split legs at ordered waypoint occurrences. Reject malformed
  or empty upstream output. Resample elevation to the uniform interval expected
  by Route. Never turn missing heights into zero.
- Test repeated/nearby waypoints, missing elevations, malformed indices/times,
  roundabouts, failed alternatives, and actual fallback supplier attribution.
- Map bicycle type, hills and quiet-road preferences to Valhalla costing options;
  update source disclosures for both engines and verify source policy gates.

### Task 3: Persistent options, planning UI and navigation

Files: core stores/directionsStore.ts, stores/navigationStore.ts, hooks/useDirections.ts,
navigation/offlineSession.ts; web RouteOptions.tsx, DirectionsPanelContent.tsx,
integration-api/map/useDrawnDirectionsRoutes.ts, lib/directions/scheduleRequest.ts,
components/panels/directions/RouteCard.tsx; mobile GroundRerouteService.ts;
packages/i18n/locales/{en,de}.json and focused tests.

- Write failing tests proving store persistence, cycling-only query identity,
  identical panel/map request inputs and preserved navigation options.
- Add compact selects and a checkbox using existing MUI components. Reuse the
  existing hill-preference vocabulary. Bike preferences persist like route avoids.
- Carry the same values into every planning query, mode preview, scheduled request
  and navigation start. Browser reroute already spreads captured options; mobile
  reroute must explicitly validate and forward them. Optional fields preserve
  compatibility with existing saved navigation sessions.

### Task 4: Links and saved route snapshots

Files: core/types/share.ts; api/services/share-links.ts, routes/shares.ts; web
lib/deepLink.ts, components/map/DeepLinkManager.tsx, ShareRouteDialog.tsx and the
public share route page; related tests and committed OpenAPI output.

- Write failing round-trip tests for route URL options and revocable share payloads,
  including malformed enums/flags and legacy payloads with no bike fields.
- Preserve bike preferences through copied URLs, restore and public route shares;
  validate at API boundaries and regenerate OpenAPI, inspecting the diff.

### Task 5: Review, verification and deployment

- Self-review each task, then obtain one fresh read-only whole-feature review.
  Fix important findings with regression tests. Maintain execution rulings.
- Run focused tests, complete lint/type/policy/OpenAPI checks, appropriate production
  builds and the full portable suite. Add a changeset for affected public packages.
- Commit and push main. Verify trusted-main CI and published release images for
  that exact commit; resolve and apply the release via existing deployment tools.
- Test on openmapx.com: cycling engine, different bike types, hills/quiet-road
  preferences, alternatives/legs, attribution, sharing, responsive UI and fallback
  outside Germany or with BRouter unavailable. Restore BRouter after outage tests.
  Confirm driving remains on its existing engine and public health is healthy.

## Review focus

All input dimensions in caches and shares; preference loss between panel/map and
rerouting; numeric voicehint mapping and ordered geometry; malformed/missing
upstream values; defaults masking unsupported profile capabilities; no public
endpoint fallback; actual supplying engine attribution; optional service recovery.

## Plan self-review

The service prerequisite matches the user's requested sequence. All request paths
that copy avoidance options are explicitly included. The existing transit hill
preference is reused rather than duplicated. Unsupported combinations preserve
intent through Valhalla. Optional fields keep old shares and snapshots readable.
