# Offline Navigation Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let an online-planned ground route survive reload and connectivity loss as an honest offline continuation session, while suppressing offline reroute/live-data requests and preserving the existing online routing behavior.

**Architecture:** Persist a schema-versioned ground-navigation snapshot in IndexedDB through a browser adapter, restore it only after validation and explicit user confirmation, and keep the existing in-memory navigation engine as the source of live progress and voice cues. Add typed connectivity/degraded state to the navigation store; when offline, the engine keeps the old route and suppresses reroute requests, and when online it permits one deliberate retry. Use Plan A's offline package resolver to distinguish basemap coverage from route-line availability. Transit navigation and local route computation remain outside this plan.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zustand, @openmapx/core route/navigation types, existing browser IndexedDB helper, React/MUI, next-intl, MapLibre package coverage resolver from Plan A, and the current ground navigation GPS/voice/progress engine.

## Global Constraints

- Read docs/plans/2026-08-03-offline-maps-design-spec.md and docs/plans/2026-08-03-offline-map-packages-implementation.md before implementing any task.
- Implement only degraded continuation of an already planned ground route; do not add a local OSRM/Valhalla/GraphHopper graph or arbitrary offline route planning.
- Keep transit navigation, transit replanning, and transit live refresh behavior unchanged except for shared connectivity copy where an existing component already reports network limitations.
- Persist route geometry, maneuver instructions, destination waypoints, provider/options, route fingerprint, progress checkpoint, and package compatibility data; do not persist raw GPS fixes on every update.
- Persist on navigation start, route selection, successful reroute, and a bounded checkpoint interval of 15 seconds or 1,000 meters, whichever occurs later; explicit stop and arrival clear the snapshot.
- Restore only schema-valid, non-expired snapshots and require explicit user confirmation before entering active navigation.
- A route snapshot may be available while the basemap is not. The UI must distinguish route-line availability, current basemap coverage, reroute availability, and live-data freshness.
- When offline or when a reroute request fails because of connectivity, retain the old route, set typed reroute-unavailable state, suppress retry storms, and never label stale traffic as current.
- When connectivity returns, do not automatically replace the route. A deliberate retry or the next controlled off-route retry may issue one directions request.
- Use Plan A's OfflinePackageResolver and compatibility rules; do not duplicate bbox/package selection logic in navigation code.
- Do not log route geometry, GPS coordinates, destination labels, raw bboxes, or full route snapshots. Route snapshots remain local to the origin.
- Preserve unrelated worktree changes. Never use destructive Git commands or stage unrelated files.
- Use co-located Vitest tests and run pnpm lint, pnpm check-types, and pnpm test after focused checks.
- Commit each independently testable task with a focused conventional commit.

---

## Dependency graph and file map

Plan B starts after Plan A has published the shared package contract and browser
resolver. Implement tasks in numeric order.

| Area | Files to create | Files to modify | Responsibility |
| --- | --- | --- | --- |
| Core snapshot contract | packages/core/src/navigation/offlineSession.ts, packages/core/src/navigation/offlineSession.test.ts | packages/core/src/index.ts | Snapshot schema, serialization, validation, expiry, safe field selection |
| Browser persistence | apps/web/src/lib/navigation/navigationSessionStorage.ts, navigationSessionStorage.test.ts | none | IndexedDB key, error handling, clear/read/write |
| Store capability state | none | packages/core/src/stores/navigationStore.ts, packages/core/src/stores/index.ts, packages/core/src/stores/navigationStore.offline.test.ts | Connectivity, reroute-unavailable state, deliberate retry nonce, snapshot restore action |
| Session lifecycle | apps/web/src/lib/navigation/useNavigationSessionPersistence.ts, useNavigationSessionPersistence.test.ts, apps/web/src/components/navigation/NavigationSessionResumeDialog.tsx, NavigationSessionResumeDialog.test.tsx | apps/web/src/components/navigation/NavigationView.tsx | Restore prompt, persistence subscription, checkpoint throttling, explicit clear |
| Connectivity and engine | apps/web/src/lib/navigation/navigationConnectivity.ts, navigationConnectivity.test.ts | apps/web/src/lib/navigation/useNavigationEngine.ts, useNavigationEngine.test.tsx, useFasterRoute.ts, useNavIncidents.ts, useNavTrafficSignals.ts, useNavAlerts.ts | Online/offline events, reroute suppression, one retry, live-data gating |
| Coverage state | apps/web/src/lib/navigation/offlineRouteCoverage.ts, offlineRouteCoverage.test.ts | apps/web/src/components/navigation/NavigationView.tsx, apps/web/src/lib/navigation/useNavigationSessionPersistence.ts | Route-line versus basemap compatibility and coverage messaging |
| Navigation UI/copy | apps/web/src/components/navigation/OfflineNavigationBanner.tsx, OfflineNavigationBanner.test.tsx | apps/web/src/components/navigation/NavigationView.tsx, NavBottomBar.tsx, packages/i18n/locales/en.json, packages/i18n/locales/de.json | Offline continuation, unavailable reroute, stale/live-data copy and action |
| Acceptance/docs | none | none | Full tests, browser matrix, route snapshot privacy and capability documentation |

## Shared snapshot interface

Task 1 defines the exact contract consumed by every later task.

~~~ts
export const NAVIGATION_SESSION_SCHEMA_VERSION = 1;
export const NAVIGATION_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface NavigationSessionSnapshot {
  schemaVersion: 1;
  kind: "ground";
  route: Route;
  routes: Route[];
  activeRouteIndex: number;
  routeSelectionIntent: "automatic" | "userSelected";
  mode: "driving" | "walking" | "cycling" | "motorcycle";
  routeOptions: NavigationRouteOptions;
  routeProvider: string | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  packageIds: string[];
  startedAtMs: number;
  updatedAtMs: number;
  lastKnownPosition?: {
    coords: LngLat;
    timestampMs: number;
  };
}
~~~

The snapshot deliberately excludes transient fasterRoute, live speed-limit
windows, incidents, rerouteFailedNonce, GPS history, coasting anchors, and
voice/screen preferences already persisted through existing preference keys.
Route contains geometry and maneuver data already returned by the directions API;
it is not a new directions-response cache.

## Tasks

### Task 0: Verify Plan A contract and navigation drift

**Files:**

- Read only: docs/plans/2026-08-03-offline-maps-design-spec.md, docs/plans/2026-08-03-offline-map-packages-implementation.md, packages/core/src/stores/navigationStore.ts, packages/core/src/types/routing.ts, packages/core/src/navigation/types.ts, apps/web/src/lib/navigation/useNavigationEngine.ts, apps/web/src/components/navigation/NavigationView.tsx
- Test-only output: temporary JSON snapshots outside the repository

**Interfaces:**

- Consumes: Plan A's exported OfflinePackageResolver, OfflineCoverageState, and shared manifest compatibility predicate.
- Produces: an implementation handoff note confirming exact current store actions, route fields, package resolver methods, and any source drift before code changes.

- [ ] **Step 1: Check the navigation worktree diff.**

~~~bash
git status --short
git diff --stat a242b5a39faf045b23ab54bc0799bf71b35d00a2 -- packages/core/src/stores/navigationStore.ts packages/core/src/types/routing.ts packages/core/src/navigation apps/web/src/lib/navigation apps/web/src/components/navigation
~~~

Expected: unrelated changes remain unstaged; any navigation drift is reread
before the snapshot interface is implemented.

- [ ] **Step 2: Confirm Plan A exports compile before depending on them.**

~~~bash
pnpm --filter @openmapx/core check-types
pnpm --filter web check-types
~~~

Expected: package resolver types from Plan A are importable without adding a
second coverage implementation.

- [ ] **Step 3: Capture a route fixture without real location data.**

Create an in-memory route fixture with three geometry points, two steps, one
destination waypoint, one alternative, and a progress checkpoint. Keep it in
the test file; do not write route coordinates to telemetry or a repository
fixture that resembles a user trip.

- [ ] **Step 4: Stop if the route object lacks the required maneuver data.**

The existing Route and RouteStep fields must supply geometry, instructions,
step coordinates, and voice fields for cold continuation. If a required field
is missing, document the exact field and update the snapshot contract before
continuing; do not solve the gap by caching arbitrary API responses.

### Task 1: Define and validate the core navigation-session snapshot

**Files:**

- Create: packages/core/src/navigation/offlineSession.ts
- Create: packages/core/src/navigation/offlineSession.test.ts
- Modify: packages/core/src/index.ts

**Interfaces:**

- Consumes: Route, RouteStep, LngLat, NavProgress, NavigationRouteOptions, and Plan A package ID semantics.
- Produces: NavigationSessionSnapshot, createNavigationSessionSnapshot, parseNavigationSessionSnapshot, isNavigationSessionExpired, and navigationSessionFingerprint.

Use these signatures:

~~~ts
export function createNavigationSessionSnapshot(input: {
  route: Route;
  routes: Route[];
  activeRouteIndex: number;
  routeSelectionIntent: "automatic" | "userSelected";
  mode: "driving" | "walking" | "cycling" | "motorcycle";
  routeOptions: NavigationRouteOptions;
  routeProvider: string | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  packageIds: string[];
  startedAtMs: number;
  updatedAtMs: number;
  lastKnownPosition?: { coords: LngLat; timestampMs: number };
}): NavigationSessionSnapshot;

export function parseNavigationSessionSnapshot(
  value: unknown,
): NavigationSessionSnapshot | null;

export function isNavigationSessionExpired(
  snapshot: NavigationSessionSnapshot,
  nowMs: number,
): boolean;

export function navigationSessionFingerprint(
  snapshot: Pick<
    NavigationSessionSnapshot,
    "route" | "destinationWaypoints" | "mode" | "routeProvider"
  >,
): string;
~~~

- [ ] **Step 1: Write failing pure tests.**

Add tests named:

Required test cases:
- creates a schema-version-one snapshot with route and maneuver data
- does not include transient faster-route, incident, or GPS-history fields
- round-trips a valid snapshot through JSON
- rejects a non-ground kind, transit mode, missing geometry, or empty steps
- rejects invalid route alternatives and an out-of-range activeRouteIndex
- rejects non-finite coordinates and timestamps
- rejects an expired snapshot after the 24-hour retention window
- produces the same fingerprint for equivalent route/session inputs
- changes the fingerprint when route geometry or destination changes

Use an assertion that catches accidental API-response dumping:

~~~ts
const snapshot = createNavigationSessionSnapshot(input);
expect(snapshot).not.toHaveProperty("rawResponse");
expect(snapshot).not.toHaveProperty("gpsHistory");
expect(snapshot).not.toHaveProperty("incidents");
expect(snapshot.route.steps[0].instruction).toBe("Turn right");
~~~

- [ ] **Step 2: Run tests before implementation.**

~~~bash
pnpm exec vitest run packages/core/src/navigation/offlineSession.test.ts
~~~

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement explicit field copying and validation.**

Copy only interface fields into a fresh object; never retain a reference to a
mutable Zustand state object. Validate geometry length, step coordinates, travel
mode, route alternatives, waypoints, package ID strings, timestamps, progress
ranges, and JSON-safe finite numbers. Use schema version 1 as a hard
compatibility gate. Keep the max age constant in the core module so browser and
tests share one value.

- [ ] **Step 4: Implement a stable route fingerprint.**

Canonicalize route geometry and destination coordinates to six decimal places,
include mode/provider, and hash the resulting string with the repository's
existing deterministic hash utility. The fingerprint is an identity/check value,
not a user-location telemetry field.

- [ ] **Step 5: Export and run focused checks.**

~~~bash
pnpm exec vitest run packages/core/src/navigation/offlineSession.test.ts
pnpm --filter @openmapx/core check-types
~~~

- [ ] **Step 6: Commit the snapshot contract.**

~~~bash
git add packages/core/src/navigation/offlineSession.ts packages/core/src/navigation/offlineSession.test.ts packages/core/src/index.ts
git commit -m "feat: define persisted navigation session"
~~~

### Task 2: Add the browser IndexedDB route-session adapter

**Files:**

- Create: apps/web/src/lib/navigation/navigationSessionStorage.ts
- Create: apps/web/src/lib/navigation/navigationSessionStorage.test.ts

**Interfaces:**

- Consumes: NavigationSessionSnapshot and existing idbGet, idbSet, idbDelete helpers.
- Produces: readNavigationSession, writeNavigationSession, and clearNavigationSession.

Use this interface:

~~~ts
export const NAVIGATION_SESSION_STORAGE_KEY = "openmapx:navigation-session:v1";

export interface NavigationSessionStorage {
  read(): Promise<NavigationSessionSnapshot | null>;
  write(snapshot: NavigationSessionSnapshot): Promise<void>;
  clear(): Promise<void>;
}
~~~

- [ ] **Step 1: Write failing storage tests.**

Test:

Required test cases:
- reads no session when the key is absent
- writes and reads a schema-valid snapshot
- returns null and clears corrupt JSON
- clears an expired snapshot before returning
- does not throw when IndexedDB is unavailable
- does not write a transit snapshot

- [ ] **Step 2: Run tests before implementation.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/navigationSessionStorage.test.ts
~~~

Expected: FAIL for missing adapter exports.

- [ ] **Step 3: Implement the adapter over the existing IndexedDB helper.**

Use the exact key openmapx:navigation-session:v1. Validate every value with
parseNavigationSessionSnapshot after reading. On corrupt, expired, or
incompatible data, clear only this key and return null. Preserve unrelated
IndexedDB records and do not use localStorage for route geometry.

- [ ] **Step 4: Keep write frequency under lifecycle control.**

The adapter performs one record write; the persistence hook in Task 4 controls
when writes occur. Do not add a write-on-every-GPS-fix behavior here.

- [ ] **Step 5: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/navigationSessionStorage.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/navigation/navigationSessionStorage.ts apps/web/src/lib/navigation/navigationSessionStorage.test.ts
git commit -m "feat: store navigation sessions in IndexedDB"
~~~

### Task 3: Add typed connectivity and reroute-degraded state to the core store

**Files:**

- Modify: packages/core/src/stores/navigationStore.ts
- Modify: packages/core/src/stores/index.ts
- Create: packages/core/src/stores/navigationStore.offline.test.ts

**Interfaces:**

- Consumes: existing ground navigation store actions and NavigationSessionSnapshot.
- Produces: NavigationConnectivity, RerouteAvailability, connectivity, rerouteUnavailable, liveDataUnavailable, rerouteRetryNonce, setConnectivity, setRerouteUnavailable, requestRerouteRetry, and restoreGroundNavigation.

Add these exact types and state fields:

~~~ts
export type NavigationConnectivity = "online" | "offline";
export type RerouteAvailability = "available" | "unavailable";

interface NavigationState {
  connectivity: NavigationConnectivity;
  rerouteUnavailable: boolean;
  liveDataUnavailable: boolean;
  rerouteRetryNonce: number;
  setConnectivity: (value: NavigationConnectivity) => void;
  setRerouteUnavailable: (value: boolean) => void;
  setLiveDataUnavailable: (value: boolean) => void;
  requestRerouteRetry: () => void;
  restoreGroundNavigation: (snapshot: NavigationSessionSnapshot) => void;
}
~~~

- [ ] **Step 1: Write failing store tests.**

Add tests named:

Required test cases:
- starts a ground route with online/available capability state
- sets offline connectivity without clearing route or progress
- sets reroute unavailable without changing navigation status to idle
- increments rerouteRetryNonce only when a retry is requested
- resets degraded state after a successful applyReroute
- restores a valid snapshot without restoring transient faster-route state
- clears the session state on stop and arrival
- does not use restoreGroundNavigation for a transit snapshot

- [ ] **Step 2: Run tests before implementation.**

~~~bash
pnpm exec vitest run packages/core/src/stores/navigationStore.offline.test.ts
~~~

- [ ] **Step 3: Add fields and actions with safe reset semantics.**

Initialize connectivity to online, rerouteUnavailable/liveDataUnavailable to
false, and retry nonce to zero. startGroundNavigation, applyReroute,
completeArrival, and stopNavigation must reset appropriate transient/degraded
fields. Setting connectivity offline must not clear route, progress, voice
preferences, or route alternatives. restoreGroundNavigation must copy the
validated snapshot into a fresh ground state and reset transient fields.

- [ ] **Step 4: Preserve existing navigation-store behavior.**

Run existing faster-route/store tests together with new tests. Existing status,
route selection, progress, voice, keep-screen-on, transit, and alternative-route
semantics must remain unchanged.

- [ ] **Step 5: Run focused checks and commit.**

~~~bash
pnpm exec vitest run packages/core/src/stores/navigationStore.offline.test.ts packages/core/src/stores/navigationStore.test.ts packages/core/src/stores/navigationStore.fasterRoute.test.ts
pnpm --filter @openmapx/core check-types
git add packages/core/src/stores/navigationStore.ts packages/core/src/stores/index.ts packages/core/src/stores/navigationStore.offline.test.ts
git commit -m "feat: track offline navigation capability"
~~~

### Task 4: Persist route lifecycle events and add an explicit resume prompt

**Files:**

- Create: apps/web/src/lib/navigation/useNavigationSessionPersistence.ts
- Create: apps/web/src/lib/navigation/useNavigationSessionPersistence.test.ts
- Create: apps/web/src/components/navigation/NavigationSessionResumeDialog.tsx
- Create: apps/web/src/components/navigation/NavigationSessionResumeDialog.test.tsx
- Modify: apps/web/src/components/navigation/NavigationView.tsx
- Modify: apps/web/src/lib/navigation/navigationSessionStorage.ts only to inject test storage

**Interfaces:**

- Consumes: NavigationSessionSnapshot, NavigationSessionStorage, useNavigationStore, and Plan A's OfflinePackageResolver.
- Produces: useNavigationSessionPersistence() returning pending snapshot, accept/discard actions, and current route-line/basemap coverage status.

Use this interface:

~~~ts
export interface NavigationSessionResumeState {
  pending: NavigationSessionSnapshot | null;
  coverage: "covered" | "route-line-only" | "not-downloaded";
  accept: () => void;
  discard: () => Promise<void>;
}

export function useNavigationSessionPersistence(
  storage?: NavigationSessionStorage,
  resolver?: OfflinePackageResolver,
): NavigationSessionResumeState;
~~~

- [ ] **Step 1: Write failing persistence tests for lifecycle boundaries.**

Test:

Required test cases:
- writes on a new ground-navigation start
- writes when the active route or selected alternative changes
- writes after a successful reroute
- writes progress only after 15 seconds or 1000 meters
- does not write every GPS fix inside the checkpoint window
- clears the snapshot on explicit stop and arrival
- offers a valid snapshot after an offline reload
- does not auto-enter navigation before accept is called
- discards a corrupt or expired session
- reports route-line-only when no compatible package covers the current route

- [ ] **Step 2: Run hook/component tests before implementation.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/useNavigationSessionPersistence.test.ts apps/web/src/components/navigation/NavigationSessionResumeDialog.test.tsx
~~~

Expected: FAIL because hook/dialog do not exist.

- [ ] **Step 3: Implement the store subscription and bounded checkpoint policy.**

Subscribe to the navigation store after mount. Persist immediately when status
changes into navigating, the active route/alternative/provider/options/waypoints
change, or a reroute is applied. For progress-only changes, persist only when
both the time or distance checkpoint threshold has elapsed according to the
15-second or 1,000-meter policy; use a monotonic last-write record in the hook.
Persist package IDs returned by resolver.packageIdsForGeometry for the current
route geometry.

- [ ] **Step 4: Implement restore validation and explicit confirmation.**

On first client mount while the store is idle, read the session, validate
schema/age, and calculate coverage. Return it as pending. The dialog shows
destination/route summary from local data, Resume route and Discard route
actions, and a statement that offline rerouting is unavailable. Accept calls
restoreGroundNavigation and keeps the snapshot until the first lifecycle write;
Discard clears only the navigation-session key.

- [ ] **Step 5: Mount the hook before NavigationView's early return.**

NavigationView currently invokes hooks and then returns null while idle. Mount
the persistence hook before the active conditional so an offline cold start can
render the resume dialog. Keep transit navigation excluded by checking
kind === ground and snapshot kind.

- [ ] **Step 6: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/useNavigationSessionPersistence.test.ts apps/web/src/components/navigation/NavigationSessionResumeDialog.test.tsx
pnpm --filter web check-types
git add apps/web/src/lib/navigation/useNavigationSessionPersistence.ts apps/web/src/lib/navigation/useNavigationSessionPersistence.test.ts apps/web/src/components/navigation/NavigationSessionResumeDialog.tsx apps/web/src/components/navigation/NavigationSessionResumeDialog.test.tsx apps/web/src/components/navigation/NavigationView.tsx apps/web/src/lib/navigation/navigationSessionStorage.ts
git commit -m "feat: resume navigation sessions after reload"
~~~

### Task 5: Implement browser connectivity state and suppress offline reroutes

**Files:**

- Create: apps/web/src/lib/navigation/navigationConnectivity.ts
- Create: apps/web/src/lib/navigation/navigationConnectivity.test.ts
- Modify: apps/web/src/lib/navigation/useNavigationEngine.ts
- Modify: apps/web/src/lib/navigation/useNavigationEngine.test.tsx
- Modify: apps/web/src/lib/navigation/useFasterRoute.ts, apps/web/src/lib/navigation/useFasterRoute.test.ts

**Interfaces:**

- Consumes: core connectivity/retry actions from Task 3 and browser online/offline events.
- Produces: readNavigationConnectivity, useNavigationConnectivity, isConnectivityFailure, and one controlled retry path.

Use these helpers:

~~~ts
export function readNavigationConnectivity(): NavigationConnectivity;
export function isConnectivityFailure(
  error: unknown,
  connectivity: NavigationConnectivity,
): boolean;
export function useNavigationConnectivity(): NavigationConnectivity;
~~~

- [ ] **Step 1: Write failing connectivity/engine tests.**

Add tests named:

Required test cases:
- reads navigator.onLine false as offline
- updates the store on online and offline events
- does not call fetchDirections for an off-route fix while offline
- keeps the old route and marks reroute unavailable after an offline fix
- does not create a retry timer storm while offline
- does not clear reroute unavailable merely because the browser is online again
- issues one deliberate retry after requestRerouteRetry on a subsequent valid fix
- applies the new route and clears degraded state after a successful retry
- retains the old route and unavailable state after retry failure
- keeps existing online reroute behavior unchanged

- [ ] **Step 2: Run focused tests before implementation.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/navigationConnectivity.test.ts apps/web/src/lib/navigation/useNavigationEngine.test.tsx apps/web/src/lib/navigation/useFasterRoute.test.ts
~~~

- [ ] **Step 3: Implement online/offline event subscription.**

useNavigationConnectivity reads navigator.onLine on mount, subscribes to window
online/offline, calls setConnectivity, and cleans up listeners. A browser online
event changes connectivity only; it does not clear rerouteUnavailable or replace
the route.

- [ ] **Step 4: Add connectivity-aware reroute gating to the engine.**

Before fetchDirections, require connectivity online, a qualifying off-route
result, no in-flight reroute, and no recording replay. When offline, set
rerouteUnavailable, return status to navigating, and leave route/progress/voice
data unchanged. In the fetch catch branch, classify network/TypeError/offline
failures with isConnectivityFailure; set unavailable for those and retain the
old route. Preserve existing transient failure nonce for non-connectivity
errors.

- [ ] **Step 5: Add one controlled retry nonce.**

requestRerouteRetry increments the store nonce. The engine tracks the last handled
nonce and, on the next accepted GPS fix while online and off-route, permits
exactly one reroute attempt. Mark the nonce handled before the request starts so
repeated renders cannot duplicate it. A successful response calls applyReroute;
a failed response leaves rerouteUnavailable true. The banner from Task 8 calls
this action once per user press.

- [ ] **Step 6: Gate faster-route polling on typed connectivity.**

Keep the existing navigator.onLine guard as a safety check, add the store
connectivity/reroute-unavailable guard, and clear a pending faster-route offer
when connectivity changes offline. Do not alter transit replanning in this task.

- [ ] **Step 7: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/navigationConnectivity.test.ts apps/web/src/lib/navigation/useNavigationEngine.test.tsx apps/web/src/lib/navigation/useFasterRoute.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/navigation/navigationConnectivity.ts apps/web/src/lib/navigation/navigationConnectivity.test.ts apps/web/src/lib/navigation/useNavigationEngine.ts apps/web/src/lib/navigation/useNavigationEngine.test.tsx apps/web/src/lib/navigation/useFasterRoute.ts apps/web/src/lib/navigation/useFasterRoute.test.ts
git commit -m "feat: suppress offline navigation reroutes"
~~~

### Task 6: Gate live road data and traffic-signal lookups while offline

**Files:**

- Modify: apps/web/src/lib/navigation/useNavIncidents.ts
- Modify: apps/web/src/lib/navigation/useNavTrafficSignals.ts
- Modify: apps/web/src/lib/navigation/useNavAlerts.ts
- Create: apps/web/src/lib/navigation/offlineLiveData.test.ts
- Modify: apps/web/src/components/navigation/NavigationView.tsx only to consume the new live-data status

**Interfaces:**

- Consumes: useNavigationConnectivity, current route/progress, and existing live-data hooks.
- Produces: liveDataUnavailable state and empty/known-data behavior that never presents a failed network response as current live information.

- [ ] **Step 1: Write failing live-data tests.**

Test:

Required test cases:
- does not call fetchRoadConditions while offline
- does not call fetchRouteMatchWindow while offline
- does not call fetchRoadAlerts while offline
- clears pending live incidents and alerts after connectivity is lost
- keeps locally known route steps and speed limits visible while offline
- allows live fetches again after connectivity returns

- [ ] **Step 2: Run tests before modifying hooks.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/offlineLiveData.test.ts
~~~

- [ ] **Step 3: Gate each fetch at the effect boundary.**

In useNavIncidents, useNavTrafficSignals, and useNavAlerts, read typed
connectivity before scheduling an initial fetch or interval. On offline
transition, cancel/ignore in-flight responses, clear only live event state, and
return liveDataUnavailable true. Do not clear route steps, maneuvers, progress,
or route geometry.

- [ ] **Step 4: Prevent stale live values from being labeled current.**

useNavTrafficSignals must clear route live speed-limit accumulation on offline
transition while retaining per-step RouteStep.speedLimit fallbacks. useNavAlerts
and incident consumers must return no live alert after an offline transition.
The UI status says live data is unavailable rather than showing an old incident
as active.

- [ ] **Step 5: Run existing live/navigation tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/offlineLiveData.test.ts apps/web/src/lib/navigation/useNavigationEngine.test.tsx apps/web/src/lib/navigation/useFasterRoute.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/navigation/useNavIncidents.ts apps/web/src/lib/navigation/useNavTrafficSignals.ts apps/web/src/lib/navigation/useNavAlerts.ts apps/web/src/lib/navigation/offlineLiveData.test.ts apps/web/src/components/navigation/NavigationView.tsx
git commit -m "feat: mark navigation live data unavailable offline"
~~~

### Task 7: Add route-line versus basemap coverage state

**Files:**

- Create: apps/web/src/lib/navigation/offlineRouteCoverage.ts
- Create: apps/web/src/lib/navigation/offlineRouteCoverage.test.ts
- Modify: apps/web/src/lib/navigation/useNavigationSessionPersistence.ts
- Modify: apps/web/src/components/navigation/NavigationView.tsx

**Interfaces:**

- Consumes: NavigationSessionSnapshot, Plan A OfflinePackageResolver, package compatibility, current progress position, and route geometry.
- Produces: getOfflineRouteCoverage(snapshot, resolver, coordinate).

Use this exact result type:

~~~ts
export type OfflineRouteCoverage =
  | { kind: "covered"; packageId: string }
  | { kind: "route-line-only"; packageIds: string[] }
  | { kind: "not-downloaded"; packageIds: string[] };

export function getOfflineRouteCoverage(
  snapshot: NavigationSessionSnapshot,
  resolver: OfflinePackageResolver,
  coordinate: LngLat,
): OfflineRouteCoverage;
~~~

- [ ] **Step 1: Write failing coverage tests.**

Test:

Required test cases:
- reports covered when a compatible ready package contains the current coordinate
- reports route-line-only when the snapshot has a route but no current package coverage
- reports not-downloaded when the snapshot has no package IDs
- ignores packages with a different dataset/style/schema
- updates from route-line-only to covered after a package becomes ready

- [ ] **Step 2: Run tests before implementation.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/offlineRouteCoverage.test.ts
~~~

- [ ] **Step 3: Implement coverage using Plan A's resolver only.**

Filter snapshot package IDs through the resolver compatibility index, then call
packageForCoordinate with that allowlist. Do not fetch manifests by URL in
navigation code and do not reimplement bbox intersection. Use route geometry/
progress only to choose current coordinate; package selection remains owned by
Plan A.

- [ ] **Step 4: Connect coverage to resume state and NavigationView.**

The resume dialog reports route-line-only when local route data can be restored
but the map package is absent. The active navigation view updates coverage after
package-ready/delete messages and uses current progress coordinates when
available, falling back to the route's first coordinate.

- [ ] **Step 5: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/offlineRouteCoverage.test.ts apps/web/src/lib/navigation/useNavigationSessionPersistence.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/navigation/offlineRouteCoverage.ts apps/web/src/lib/navigation/offlineRouteCoverage.test.ts apps/web/src/lib/navigation/useNavigationSessionPersistence.ts apps/web/src/components/navigation/NavigationView.tsx
git commit -m "feat: distinguish offline route and map coverage"
~~~

### Task 8: Add user-facing offline navigation banner and capability copy

**Files:**

- Create: apps/web/src/components/navigation/OfflineNavigationBanner.tsx
- Create: apps/web/src/components/navigation/OfflineNavigationBanner.test.tsx
- Modify: apps/web/src/components/navigation/NavigationView.tsx, NavBottomBar.tsx
- Modify: packages/i18n/locales/en.json, packages/i18n/locales/de.json

**Interfaces:**

- Consumes: store connectivity/reroute/live-data state, OfflineRouteCoverage, and requestRerouteRetry.
- Produces: accessible, non-blocking status UI that distinguishes map coverage, route continuation, rerouting, and live-data availability.

Use this props interface:

~~~ts
interface OfflineNavigationBannerProps {
  connectivity: "online" | "offline";
  rerouteUnavailable: boolean;
  liveDataUnavailable: boolean;
  coverage: OfflineRouteCoverage;
  onRetryReroute: () => void;
}
~~~

- [ ] **Step 1: Write failing component tests.**

Assert:

Required test cases:
- says route continuation is available while offline
- says rerouting is unavailable and does not show a false current-route claim
- shows a map-not-downloaded message for not-downloaded coverage
- shows route-line-only when route data exists without the basemap
- shows a single retry action when online and rerouting is unavailable
- calls requestRerouteRetry once per retry press
- marks live data unavailable without hiding local maneuver guidance
- renders accessible status and button labels

- [ ] **Step 2: Run component tests before implementation.**

~~~bash
pnpm exec vitest run apps/web/src/components/navigation/OfflineNavigationBanner.test.tsx
~~~

- [ ] **Step 3: Implement the banner and integrate it into NavigationView.**

Render a warning banner above the navigation sheet when offline or degraded.
Use one concise summary plus details: route continuation remains available,
rerouting is unavailable offline, live traffic/incident data is not current, and
the map package is missing when coverage says so. Keep existing maneuver, voice,
progress, and route-line UI visible.

- [ ] **Step 4: Add a deliberate retry action.**

Show Retry reroute only when connectivity is online, the route is off-route, and
rerouteUnavailable is true. The button calls requestRerouteRetry; it must not
call fetchDirections directly from the component. Disable it while status is
rerouting and after the retry nonce is consumed.

- [ ] **Step 5: Update translations and verify the copy boundary.**

Add keys for route continuation, reroute unavailable, retry reroute, map not
downloaded, route line available, live data unavailable, stale traffic, resume
route, discard route, and offline routing not supported. Do not use copy that
claims full offline navigation or offline route planning.

- [ ] **Step 6: Run tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/components/navigation/OfflineNavigationBanner.test.tsx apps/web/src/components/navigation/NavigationSessionResumeDialog.test.tsx
pnpm -C packages/i18n exec tsx scripts/check-translations.ts
pnpm --filter web check-types
git add apps/web/src/components/navigation/OfflineNavigationBanner.tsx apps/web/src/components/navigation/OfflineNavigationBanner.test.tsx apps/web/src/components/navigation/NavigationView.tsx apps/web/src/components/navigation/NavBottomBar.tsx packages/i18n/locales/en.json packages/i18n/locales/de.json
git commit -m "feat: explain degraded offline navigation"
~~~

### Task 9: Run navigation acceptance, regression, and rollback checks

**Files:**

- Modify only failing focused tests or navigation code that directly caused an acceptance failure.
- Handoff artifact: local acceptance matrix and route-session schema/version notes; do not commit real route snapshots.

**Interfaces:**

- Consumes: Tasks 1–8 and Plan A's ready package/resolver implementation.
- Produces: a reviewed offline continuation release decision with no offline-routing claim.

- [ ] **Step 1: Run all focused core/navigation tests.**

~~~bash
pnpm exec vitest run packages/core/src/navigation/offlineSession.test.ts
pnpm exec vitest run packages/core/src/stores/navigationStore.offline.test.ts packages/core/src/stores/navigationStore.test.ts packages/core/src/stores/navigationStore.fasterRoute.test.ts
pnpm exec vitest run packages/core/src/navigation
~~~

- [ ] **Step 2: Run all focused browser tests.**

~~~bash
pnpm exec vitest run apps/web/src/lib/navigation/navigationSessionStorage.test.ts apps/web/src/lib/navigation/useNavigationSessionPersistence.test.ts
pnpm exec vitest run apps/web/src/lib/navigation/navigationConnectivity.test.ts apps/web/src/lib/navigation/useNavigationEngine.test.tsx
pnpm exec vitest run apps/web/src/lib/navigation/offlineLiveData.test.ts apps/web/src/lib/navigation/offlineRouteCoverage.test.ts
pnpm exec vitest run apps/web/src/components/navigation/NavigationSessionResumeDialog.test.tsx apps/web/src/components/navigation/OfflineNavigationBanner.test.tsx
~~~

- [ ] **Step 3: Run repository quality gates.**

~~~bash
pnpm lint
pnpm check-types
pnpm test
~~~

- [ ] **Step 4: Run the manual online/offline matrix.**

| Scenario | Expected result |
| --- | --- |
| Start a ground route online | Snapshot is written with route, steps, options, provider, waypoints, and package IDs |
| Reload with network disabled | Resume dialog appears; no automatic navigation start |
| Accept valid resume | Route line, progress fallback, maneuvers, voice settings, and map coverage state are available |
| Discard resume | Snapshot key is removed and navigation stays idle |
| Network drops while on route | Existing route/progress/voice continue; banner says rerouting/live data unavailable |
| Go off-route offline | No directions request, no retry storm, old route remains, reroute-unavailable state is visible |
| Network returns | State becomes online but route is not silently replaced |
| Press Retry reroute once | One controlled directions request is made; success replaces route and clears degraded state |
| Retry request fails | Old route remains and degraded state stays visible |
| Route has no local basemap | Route line may remain available; banner says map area not downloaded |
| Package covers current coordinate | Map coverage reports covered and local MapLibre package remains usable |
| Live incidents/traffic signals | No stale live alert or live speed-limit claim appears offline; static route-step data remains |
| Complete arrival or press End | Snapshot is cleared |
| Transit navigation | No ground snapshot is created and transit behavior remains unchanged |
| Snapshot is older than 24 hours or schema changes | Snapshot is discarded with a non-sensitive reason |
| Feature-flag rollback | Route-session data remains local but package/navigation UI does not claim unsupported capability |

- [ ] **Step 5: Verify privacy and schema migration behavior.**

Inspect the IndexedDB record manually in a test profile. Confirm it contains only
schema fields, route geometry/maneuvers, destination waypoints, package IDs, and
bounded progress checkpoint. Confirm no telemetry event includes the snapshot
body. Increment schema version in a temporary test and verify old data is
discarded rather than interpreted with the new shape.

- [ ] **Step 6: Write the acceptance handoff without broad staging.**

When all checks pass, attach the acceptance matrix and privacy/schema notes to
the implementation handoff. When a check fails, return to the task owning that
behavior and use that task's focused commit command; do not stage entire
navigation or locale directories for an acceptance-only commit.

The handoff must state that version one supports continuation of a route already
planned online, not new offline route planning or arbitrary offline rerouting.

## Plan B done criteria

- [ ] A schema-version-one ground route snapshot is validated, bounded, and stored locally in IndexedDB.
- [ ] Restore requires explicit user confirmation and rejects corrupt, expired, transit, or incompatible snapshots.
- [ ] Navigation start, route selection, successful reroute, bounded progress checkpoints, stop, and arrival have correct persistence behavior.
- [ ] Offline connectivity retains route geometry/progress/voice data and suppresses directions requests.
- [ ] One controlled deliberate retry is possible after connectivity returns.
- [ ] Failed retry retains the old route and unavailable state.
- [ ] Live incidents, traffic-signal lookups, and route-aware live alerts are not presented as current offline.
- [ ] Static route-step guidance and locally available progress remain usable.
- [ ] Route-line availability and basemap package coverage are separate visible states.
- [ ] Light/dark/package resolver behavior comes from Plan A, with no duplicate coverage logic.
- [ ] Transit navigation behavior remains unchanged.
- [ ] Browser copy never claims full offline routing or live data.
- [ ] Core/browser tests, full repository checks, manual matrix, and privacy/schema checks pass.

## Stop conditions and rollback

Stop and report the first failing condition if:

- a snapshot can restore transit navigation or an unsupported travel mode;
- an old/corrupt snapshot can enter active navigation without validation/confirmation;
- offline GPS fixes cause any directions request or retry loop;
- a failed reconnect silently replaces or marks the old route current;
- stale incidents, live traffic, or live speed data are shown as current offline;
- route-line availability is reported as basemap coverage;
- a schema change interprets an older snapshot instead of discarding it;
- route geometry or GPS history is sent to telemetry; or
- implementing continuation requires adding a local routing graph.

Rollback by disabling session restore/degraded-navigation UI and leaving the
existing online engine and route state behavior active. Preserve local snapshot
data until the user explicitly discards it; do not delete package archives or
unrelated caches during a code rollback.
