---
title: Navigation performance runbook
description: Capture a repeatable navigation performance and thermal baseline on a real phone with the ?navperf=1 QA HUD, compare optimizations against it, and escalate only on measured evidence.
sidebar_position: 9
---

# Navigation performance runbook

Use this runbook to compare navigation changes on the same physical phone.
Record operation counts, frame pacing, battery use, and observed OS behavior
under fixed conditions. Portable tests and simulator runs cover different
contracts and do not establish physical-device thermal performance.

The HUD below measures the browser navigation shell. The Expo host has separate
[native architecture](./mobile-architecture.md) and
[release/device checks](./mobile-release.md); a passing browser run does not
qualify background native guidance.

:::info[Local QA measurements]
The HUD described here is a QA aid. It is off unless you put `?navperf=1` in the
URL, it collects only bounded aggregates in memory, and it writes a file only
when you click **export**. Nothing is uploaded. The automatic counters retain no coordinates, route
geometry, search terms, or request URLs. Review manually entered metadata
before sharing the export.
:::

## The QA HUD

Add `navperf=1` to the query string of a navigation session
(`https://…/?navperf=1`) and start guidance. A small dark panel appears on the
left, next to the simulator panel (`?navsim=1`), with:

| Control              | Effect                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| **start** / **stop** | Attaches or detaches all measurement. Nothing is measured before the first **start**. |
| **reset**            | Zeroes the aggregates and restarts the measurement window without detaching.          |
| **export**           | Downloads the current aggregates as `navperf-run.json`.                               |
| **meta**             | Reveals the scenario picker and the manual test-metadata fields.                      |

The readout refreshes once per second. The measurement frame loop runs
separately while recording is active.

### What it records

- frames: frame-to-frame deltas from a `requestAnimationFrame` loop:
  implied FPS, the p95 over the retained window, and how many frames exceeded
  32 ms and 50 ms.
- long tasks: browser `longtask` entries (count, total, longest). Shows
  `n/a` on browsers without that entry type; use Chrome for a real run.
- map: MapLibre `render`, `move`, `moveend` and `idle` event counts.
- progress: navigation-store publications, split into "publications that
  changed the progress object" over "all store notifications".
- net: resource-timing counts, total duration, transfer and encoded bytes
  bucketed into `tile`, `road-conditions`, `routing` and `other`. Each URL is
  classified on arrival and thrown away immediately.
- metadata: device model, browser version, build SHA, brightness percent,
  network type and scenario. All typed in by you; nothing is sniffed from the
  device.

Retention is bounded (at most 1,000 retained frame samples; everything else is
an online aggregate), and all of it is discarded when the overlay unmounts.

:::caution Memory is not in the HUD
Heap sampling needs Chrome flags that change the thing being measured. Use the
DevTools Memory panel for heap questions instead of adding a counter here.
:::

## Canonical scenarios

Always compare like with like. The four canonical runs are also listed inside
the simulator panel so they are visible while you set a run up:

1. city: 10 minutes at 14 m/s on a normal route.
2. highway: 10 minutes at 33 m/s on a normal route.
3. city + reroute: 10 minutes of city driving containing exactly one
   off-route/reroute sequence (use the simulator's off-route toggle).
4. stationary: 5 minutes parked in follow mode.

Use the **same** recording (record/replay in the `?navsim=1` panel) or the same
generated route before and after an optimization. The simulator shows the loaded
recording's fix count and wall-clock length so you can confirm it is the same
artifact.

:::danger Keep playback at 1×
Fast-forward compresses per-fix work into fewer wall-clock seconds. Frame,
battery and thermal numbers taken at 2× or 4× are meaningless. The simulator
panel carries a permanent `perf runs stay at 1×` reminder for this reason.
:::

## Device protocol

### Build and serve

1. Build the production PWA (`pnpm build` in `apps/web`, or deploy the build you
   want to measure). Avoid dev builds: hot reload, source maps, and
   React development mode dominate the profile.
2. Serve it over HTTPS to the phone (staging deployment, or a TLS tunnel to the
   local build). Geolocation and service workers need a secure context.
3. Note the exact build SHA. It goes into the export metadata.

### Fix the conditions

Everything below stays identical across the before and after run:

- brightness: a fixed percentage, auto-brightness off. Display power
  usually dominates the total.
- screen: on for the entire run, device not in a case, resting on the same
  surface (a case or a car mount changes heat dissipation more than most code
  changes do).
- network: the same radio type (record `4G`, `5G` or `Wi-Fi`), same
  location, comparable signal strength.
- route, zoom, pitch, overlays: same route, same camera mode, same layers
  enabled.
- battery: start in a comparable state of charge (for example 80 to 90%), not
  charging. Charging heats the battery and invalidates the thermal comparison.

Run each scenario twice: once with live traffic/conditions enabled and once with
them disabled. The delta between those two is what tells you whether the live
data plane or the render loop is the cost driver.

### Instrument and trace

1. For an Android Chrome diagnostic trace, enable remote inspection and open
   `chrome://inspect` on the host. Record whether debugging and a cable were
   attached. A charging USB trace is a separate diagnostic run; repeat thermal
   and battery measurements unplugged, with the same debugger state before/after.
2. Start navigation and let the session warm up for five minutes. Click
   **start**, then **reset** if you recorded the warm-up. The exported window
   should cover the declared scenario, not initial style/tile loading.
3. In the diagnostic run, record a DevTools **Performance** trace for at least
   two minutes of the measured scenario. Save it privately for inspection.
4. Complete the scenario, click **stop**, then **export**. Save
   `navperf-run.json` with the run conditions and any separate diagnostic trace.
   The 30-minute release run below is additional to the shorter scenarios.

### Record the physical outcome

For each run, write down:

- battery percentage at start and at end (and the elapsed wall-clock time);
- whether Android showed a thermal warning, throttled, dimmed the display, or
  disabled mobile data;
- whether the browser tab was killed or reloaded;
- the trace filename, the exported JSON filename, and the build SHA.

:::danger[Review artifacts before sharing]
A `?navsim=1` recording can contain a real trip's GPS fixes and route geometry.
Keep it private. DevTools traces can also include request URLs and private
inputs. The HUD export contains bounded counters and manually entered metadata;
inspect that metadata before attaching it to a public issue.
:::

## Operation-count budgets

Use operation counts to detect redundant work independently of device speed.
Elapsed time still matters on the target device. The budgets below are
maintenance contracts, not evidence that an arbitrary phone passes the thermal
gate. Read the owning implementation and its adjacent tests when changing one.

| Budget                                                                                                                                             | Implementation and regression entry point                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| One marker attachment per map/session; no perpetual no-fix or settled animation loop; preserve moving camera/puck cadence                          | `apps/web/src/lib/navigation/useNavCamera.ts`, `navCameraScheduler.ts`, and adjacent tests                         |
| One navigation-store publication per accepted real fix                                                                                             | `packages/core/src/stores/navigationStore.ts` and navigation-engine tests                                          |
| No full route snapshot or route-package geometry scan between checkpoints                                                                          | `apps/web/src/lib/navigation/useNavigationSessionPersistence.ts` and adjacent tests                                |
| No full active-route GeoJSON upload for progress-only changes                                                                                      | `apps/web/src/components/map/layers/NavigationRouteLayer.tsx` and adjacent tests                                   |
| One road-condition request/polling/projection owner per route/window revision across engine, alerts, and crowd prompt                              | `apps/web/src/components/navigation/NavIncidentsProvider.tsx` and `apps/web/src/lib/navigation/useNavIncidents.ts` |
| Bound viewport scheduler evaluations independently of `moveend` frequency                                                                          | `integrations/road-conditions/viewport-scheduler.ts` and adjacent tests                                            |
| No cold dialog/menu/root render on progress-only updates                                                                                           | `apps/web/src/components/navigation/navigationRenderBoundaries.test.tsx`                                           |
| Sub-quadratic flow-overlap operation growth                                                                                                        | `packages/core/src/navigation/flowProjection.ts` and `__tests__/flowProjection.test.ts`                            |
| No production call to legacy `snapToRoute`; prepare matchers once per stable geometry or ephemeral batch, outside point/sample/waypoint/stop loops | `packages/core/src/navigation/routeMatcher.ts` and consumer tests                                                  |

The HUD's `map`, `progress`, and `net` counters show aggregate runtime activity.
Use focused tests, traces, and source inspection for budgets the HUD cannot
identify directly, such as marker attachment, source uploads, and component
renders.

## The release gate

The gate is thermal and is measured on the same device before and after:

> A 30-minute full-quality navigation run must complete without an OS thermal
> warning, a connectivity shutdown, a browser tab death, or steadily worsening
> frame time.

Do not invent a universal temperature or a battery-percent-per-hour threshold.
Display brightness, radio conditions and battery health dominate absolute
values, so only the same-device relative change between two runs is meaningful.

## Escalation after the budgets pass

If the operation-count budgets pass and the same-device thermal gate still
fails, investigate in this order. Record the residual trace and the decision,
including a decision to keep work on the main thread.

1. **Attribute the residual cost.** Capture a new trace and split the remaining
   work between main-thread long tasks, MapLibre worker/GPU work, network
   transfer and latency, radio state, and display cadence. Do not infer the
   bottleneck from the temperature.
2. **Spike a Worker only for measured work.** For any navigation computation
   still producing target-device tasks over 50 ms, build a spike with the real
   immutable input/output shape and compare clone/transfer bytes, end-to-end
   latency, main-thread responsiveness, total CPU time, and the device's power
   and thermal response. Adopt offloading only when responsiveness improves
   without a material increase in total power. Moving work to another thread
   alone does not establish a thermal improvement.
3. **Compare against native only as a last step.** If the budgets pass and the
   dominant remaining cost is demonstrably a browser/PWA platform constraint
   that cannot preserve the required feature contract, write a native
   feasibility comparison first: foreground and background location, screen-off
   guidance, MapLibre rendering, wake behaviour, web/native bridge cost, feature
   parity, and maintenance burden. A failed thermal gate on its own does not
   authorize a rewrite.

Record a justified decision against a Worker or further native migration when
the measurements do not support it. OpenMapX already has a native host; compare
the remaining browser work with that implementation before proposing another
runtime boundary.

## Route-stop comparisons

`@openmapx/core/navigation` exports `routeStopWaypointPositions`,
`remainingRouteStopWaypoints`, `insertRouteStop`, `routeStopAccess`, and
`evaluateRouteStopDetours`. Waypoint positions are resolved in itinerary order
on successive route suffixes, preserving later visits to a retraced road. Pass
the reference `alongMeters` when evaluating or inserting into a remaining route.
The evaluator accepts an injected directions request
port: callers must close over identical mode and routing preferences for baseline
and candidate requests. Its typed results distinguish network deltas, unknown
responses and explicit no-route results; an absent `AlongRoutePoi.detour` is a
geometric approximation. A source can supply `CategoryPlace.routingEntrance`;
ordinary coordinates remain an explicit fallback. This contract can be reused by
future richer stop discovery without changing its routing semantics.

Rerouting uses the same ordered occurrence resolver, starting from the itinerary
origin before comparing stop positions with current geometry-measured progress.
This retains a later stop on a retraced road and distinct repeated stops when
the intervening itinerary establishes their order. Consecutive equal-coordinate
stops share a position; coordinate-only itineraries cannot disambiguate every
intended later visit to the first intermediate stop. Provider leg distances are
not interchangeable with metres measured along the route geometry.

An accepted replacement route must adopt the exact remaining itinerary captured
for its request, including that request's origin. Web reroutes commit both in one
store update, faster-route offers carry the itinerary until acceptance, and the
mobile reroute producer includes it in the validated replacement package. Failed
or obsolete responses and declined offers leave the active itinerary unchanged.
This prevents a second reroute from resurrecting stops visited on the old route.
Legacy internal callers that omit replacement waypoints retain their existing
itinerary; callers requesting a pruned route must pass its captured waypoint list.

The web hook evaluates six candidates, two at a time, after one baseline. It
pins an enabled integration using the optional directions `provider` parameter;
normal unpinned routing retains its fallback chain, while a pin never falls back
to another graph or bypasses capability/source-policy checks. Mode-only matrices
are deliberately not used because they cannot carry the active avoid options.

The comparison origin advances in 500 m buckets. Waypoint membership changes
invalidate a bucket, while speed and ordinary position fixes only refilter
retained projections. Cache identity includes route/session, provider, preferences,
query, reference position, remaining waypoints, and candidate coordinates/entrance.
The mounted search retains at most 64 evaluations for 60 seconds, with an expiry
invalidation timer and no routing polling timer. Requests receive AbortSignals;
route/session replacement, search exit and unmount invalidate ownership. Adding a
stop uses the live position and selected place ID, resolving its current entrance
or coordinate from the latest results, so co-located places retain their distinct
entrances and stale selection coordinates cannot override a refreshed target.
A refreshed entrance cancels a pending selection.
Only the latest browser-owned request may commit or restore navigation state.
When the original route has no provider recorded, adding a verified stop pins
and persists the provider selected by its baseline comparison.

Regression fixtures define a directed road graph independently of the geometric
projection, including a wrong-side motorway facility, a river crossing, a
restricted stop and an ordinary urban stop. Hook tests cover option fidelity,
request cadence, expiry, cancellation and same-route session replacement.

## Maintenance

The HUD is an instrument, not a product feature. Before adding a permanent
metric, add the operation-count budget it is meant to defend to the table above.
Changes that make the monitor active by default, or that turn device-specific
elapsed-time observations into CI thresholds, should be rejected.
