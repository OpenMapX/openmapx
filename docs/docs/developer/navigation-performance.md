---
title: Navigation performance runbook
description: Capture a repeatable navigation performance and thermal baseline on a real phone with the ?navperf=1 QA HUD, compare optimizations against it, and escalate only on measured evidence.
sidebar_position: 9
---

# Navigation performance runbook

Sustained turn-by-turn navigation is the hardest thing OpenMapX asks of a
phone: the screen stays on, the GPS radio runs continuously, the map re-renders
every frame, and the app keeps fetching tiles and live conditions. When that
combination gets too expensive the device — not the app — reacts: Android
raises a thermal warning, throttles the CPU/GPU, dims the display, sometimes
shuts mobile data down, and in the worst case kills the browser tab.

No unit test can see any of that. This page is the protocol for measuring it, so
that a navigation optimization is judged against a captured baseline rather than
against a plausible-sounding diff.

:::info The instrument is not telemetry
The HUD described here is a QA aid. It is off unless you put `?navperf=1` in the
URL, it collects only bounded aggregates in memory, and it writes a file only
when you click **export**. Nothing is uploaded, and no coordinates, route
geometry, search terms or request URLs are ever retained.
:::

## The QA HUD

Add `navperf=1` to the query string of a navigation session
(`https://…/?navperf=1`) and start guidance. A small dark panel appears on the
left, next to the simulator panel (`?navsim=1`), with:

| Control | Effect |
| --- | --- |
| **start** / **stop** | Attaches or detaches all measurement. Nothing is measured before the first **start**. |
| **reset** | Zeroes the aggregates and restarts the measurement window without detaching. |
| **export** | Downloads the current aggregates as `navperf-run.json`. |
| **meta** | Reveals the scenario picker and the manual test-metadata fields. |

The readout refreshes once per second — deliberately, so the HUD is not itself a
per-frame workload.

### What it records

- **frames** — frame-to-frame deltas from a `requestAnimationFrame` loop:
  implied FPS, the p95 over the retained window, and how many frames exceeded
  32 ms and 50 ms.
- **long tasks** — browser `longtask` entries (count, total, longest). Shows
  `n/a` on browsers without that entry type; use Chrome for a real run.
- **map** — MapLibre `render`, `move`, `moveend` and `idle` event counts.
- **progress** — navigation-store publications, split into "publications that
  changed the progress object" over "all store notifications".
- **net** — resource-timing counts, total duration, transfer and encoded bytes
  bucketed into `tile`, `road-conditions`, `routing` and `other`. Each URL is
  classified on arrival and thrown away immediately.
- **metadata** — device model, browser version, build SHA, brightness percent,
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

1. **city** — 10 minutes at 14 m/s on a normal route.
2. **highway** — 10 minutes at 33 m/s on a normal route.
3. **city + reroute** — 10 minutes of city driving containing exactly one
   off-route/reroute sequence (use the simulator's off-route toggle).
4. **stationary** — 5 minutes parked in follow mode.

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
   want to measure) — never measure a dev build; hot reload, source maps and
   React development mode dominate the profile.
2. Serve it over HTTPS to the phone (staging deployment, or a TLS tunnel to the
   local build). Geolocation and service workers need a secure context.
3. Note the exact build SHA. It goes into the export metadata.

### Fix the conditions

Everything below stays identical across the before and after run:

- **brightness** — a fixed percentage, auto-brightness off. Display power
  usually dominates the total.
- **screen** — on for the entire run, device not in a case, resting on the same
  surface (a case or a car mount changes heat dissipation more than most code
  changes do).
- **network** — the same radio type (record `4G`, `5G` or `Wi-Fi`), same
  location, comparable signal strength.
- **route, zoom, pitch, overlays** — same route, same camera mode, same layers
  enabled.
- **battery** — start in a comparable state of charge (for example 80–90%), not
  charging. Charging heats the battery and invalidates the thermal comparison.

Run each scenario twice: once with live traffic/conditions enabled and once with
them disabled. The delta between those two is what tells you whether the live
data plane or the render loop is the cost driver.

### Instrument and trace

1. Connect the phone over USB and open `chrome://inspect` on the host
   (Android Chrome remote inspection; enable USB debugging on the device).
2. Start navigation, click **start** in the HUD, and let the session warm up for
   **five minutes** before recording anything. Early frames include style load,
   tile fill and service-worker warm-up, which are not the steady state you care
   about.
3. Record a DevTools **Performance** trace covering at least **two minutes**
   after the warm-up. Save the trace file.
4. Let the session run to the scenario's full length, then click **export** and
   save `navperf-run.json` next to the trace.

### Record the physical outcome

For each run, write down:

- battery percentage at start and at end (and the elapsed wall-clock time);
- whether Android showed a thermal warning, throttled, dimmed the display, or
  disabled mobile data;
- whether the browser tab was killed or reloaded;
- the trace filename, the exported JSON filename, and the build SHA.

:::danger Never attach a navigation recording to a public issue
A `?navsim=1` recording contains the real GPS fix stream and the route geometry
of an actual trip. The `navperf` export is safe to attach; the recording is not.
:::

## Operation-count budgets

Elapsed-time thresholds are worthless across devices — a flagship and a
mid-range phone disagree by a factor of five on identical code. Operation counts
do not vary with device speed, so those are the CI-adjacent budgets. Each is
introduced by a specific optimization step and is expected to hold from then on.

| Budget | From |
| --- | --- |
| One `Marker.addTo` per map/session; one marker attachment per map/session; no perpetual no-fix/settled RAF loop; unchanged moving-frame camera/puck cadence | 021 |
| One navigation-store publication per accepted real fix | 022 |
| No full route snapshot or route-package geometry scan between checkpoints | 023 |
| No full active-route GeoJSON source upload on progress-only changes | 025 |
| One road-condition request/polling/projection owner per route/window revision across engine, alerts and crowd prompt | 026 |
| Bounded viewport road-condition scheduler evaluations regardless of MapLibre `moveend` frequency | 027 |
| No cold dialog/menu/root render on progress-only updates | 028 |
| Sub-quadratic flow-overlap operation growth | 029 |
| No production module invokes legacy `snapToRoute`; prepared matcher construction happens once per stable geometry or once per ephemeral batch, never inside a point/sample/waypoint/stop loop | 024 / 026 / 029 |

The HUD's `map`, `progress` and `net` counters are how most of these are checked
on-device; the rest are checked by unit tests and by reading the diff.

## The release gate

The gate is thermal and is measured on the same device before and after:

> A 30-minute full-quality navigation run must complete without an OS thermal
> warning, a connectivity shutdown, a browser tab death, or steadily worsening
> frame time.

Do not invent a universal temperature or a battery-percent-per-hour threshold.
Display brightness, radio conditions and battery health dominate absolute
values, so only the same-device relative change between two runs is meaningful.

## Escalation after the budgets pass

If plans 021–030 all meet their operation budgets and the same-device thermal
gate still fails, escalate in this order. Each step requires evidence; a hot
phone alone authorizes nothing.

1. **Attribute the residual cost.** Capture a new trace and split the remaining
   work between main-thread long tasks, MapLibre worker/GPU work, network
   transfer and latency, radio state, and display cadence. Do not infer the
   bottleneck from the temperature.
2. **Spike a Worker only for measured work.** For any navigation computation
   still producing target-device tasks over 50 ms, build a spike with the real
   immutable input/output shape and compare clone/transfer bytes, end-to-end
   latency, main-thread responsiveness, total CPU time, and the device's power
   and thermal response. Adopt offloading only when responsiveness improves
   without a material increase in total power — moving the same work to another
   thread is not a thermal success.
3. **Compare against native only as a last step.** If the budgets pass and the
   dominant remaining cost is demonstrably a browser/PWA platform constraint
   that cannot preserve the required feature contract, write a native
   feasibility comparison first: foreground and background location, screen-off
   guidance, MapLibre rendering, wake behaviour, web/native bridge cost, feature
   parity, and maintenance burden. A failed thermal gate on its own does not
   authorize a rewrite.

Whatever the outcome, link the residual trace and the decision from here —
including a justified "no Worker" or "no native spike" conclusion when the
evidence does not support one.

## Maintenance

The HUD is an instrument, not a product feature. Before adding a permanent
metric, add the operation-count budget it is meant to defend to the table above.
Changes that make the monitor active by default, or that turn device-specific
elapsed-time observations into CI thresholds, should be rejected.
