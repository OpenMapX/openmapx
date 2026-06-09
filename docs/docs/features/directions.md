---
title: Directions & navigation
description: Door-to-door routing for driving, cycling, and walking, with route options, turn-by-turn navigation, elevation, and a flights deep-link.
sidebar_position: 2
---

# Directions & navigation

Directions answer the most common map question: how do I get from here to there?
OpenMapX computes door-to-door routes for driving, cycling, and walking,
draws them on the map, and — for road travel — walks you through every turn with
in-browser turn-by-turn navigation. Public-transit journeys are planned by a
separate engine and have [their own page](./public-transit.md); this page covers
the three ground-routing modes plus the flights deep-link.

Like everything else in OpenMapX, the routing here runs on infrastructure you
control. The map app talks only to your own API server, which proxies a routing
**engine** — by default a self-hosted one. No request reaches a third party
unless you point an engine at a third-party host.

## What you can do

- **Get a route** between two points, by car, bike, or on foot, with distance,
  duration, and a road-level summary (for example, "via A57").
- **Add stops.** A route can carry intermediate waypoints, and OpenMapX can
  reorder them into the shortest multi-stop trip.
- **Compare alternatives.** For a two-point trip the engine returns up to a few
  alternative routes; pick the one you prefer and it becomes the active route on
  the map.
- **Tune the route** with avoid options (highways, tolls, ferries) and switch
  between metric and imperial units.
- **Read the elevation profile** for bike and foot routes — total ascent and
  descent, the high point, average grade, and a chart that highlights where the
  climbs are.
- **Navigate turn by turn** in the browser, with a maneuver banner, lane
  guidance, speed-limit badges, spoken instructions, automatic rerouting when you
  leave the route, and a keep-screen-on option.
- **Hand off long-distance trips to a flight search** — the flying mode
  deep-links to an external flight engine with your trip pre-filled.

## How routing works

Routing is built from small, replaceable pieces, the same plugin model as the
rest of OpenMapX (see [How it works](../overview/how-it-works.md)). The
`routing` integration is an **orchestrator**: it owns the API the app calls, but
does no path-finding itself. The actual work is delegated to a **routing
provider** — a thin adapter in front of a routing engine.

Two engine adapters ship in the box:

| Integration        | Engine    | Modes                       | Scale       | Extras                                                  |
| ------------------ | --------- | --------------------------- | ----------- | ------------------------------------------------------- |
| `routing-valhalla` | Valhalla  | driving, cycling, walking   | planet      | elevation profiles, departure/arrival times, map matching |
| `routing-osrm`     | OSRM      | driving                     | region only | very fast driving queries                               |

When the app requests directions, the orchestrator looks at the travel mode and
selects every provider that supports it, in registration order. It tries them in
turn, so if one engine is briefly unreachable the request falls through to the
next compatible one instead of failing. Each engine adapter is bound at startup
to a routing service through the `routing-engine` capability, falling back to a
configured endpoint when no local service is wired up.

The split between the two engines is deliberate:

- **Valhalla** is the general-purpose engine. It routes for all three modes,
  handles planet-scale data, and is the only one that produces elevation
  profiles, honors departure/arrival times, and supports map matching. In a
  planet deployment, Valhalla handles everything — including driving.
- **OSRM** is a region-scoped, driving-only engine optimized for speed. Where a
  regional OSRM build is available, it answers car routes quickly; the chain
  still falls back to Valhalla when OSRM is absent or unavailable.

Because providers are selected by capability rather than hard-wired, a
deployment that runs only Valhalla still serves all three modes; adding OSRM
simply gives driving a faster path. You choose which engines run by enabling the
corresponding services — see the [Valhalla and OSRM engine
guides](#configuration) below.

### Travel modes

The orchestrator accepts four UI modes for the directions panel: **driving**,
**cycling**, **walking**, and **flying**. Transit is intentionally not routed
here — a request for transit mode is redirected to the transit planner. Flying is
not a routed mode at all; it is a deep-link feature, described
[below](#flights-a-deep-link-not-live-data).

For driving, OpenMapX maps avoid options onto each engine's native vocabulary:
avoiding highways, tolls, and ferries on Valhalla, and the equivalent excludes on
OSRM. Highway and toll avoidance apply to driving; ferries can be avoided on foot
and bike too.

### Departure and arrival times

The routing API can pin a route to a wall-clock **departure** or **arrival**
time, which Valhalla uses to honor time-conditional access (school zones,
time-restricted lanes, ferry schedules) and, where available, predicted speeds.
Engines that ignore time inputs are filtered out of the chain for a timed
request, so a pinned time never silently returns an untimed route. In the app,
the leave-now / depart-at / arrive-by picker is surfaced for transit journeys; the
time-aware capability is available to driving, cycling, and walking through the
API.

## Route options

The directions panel exposes the tuning knobs that map onto the routing API:

- **Avoid** — highways and tolls (driving only) and ferries (any ground mode).
- **Units** — kilometers or miles, a per-user setting that also controls how
  distances and elevation read throughout the app.
- **Alternatives** — returned automatically for a straight two-point trip (no
  intermediate stops). Each alternative is a selectable card; the chosen one is
  highlighted on the map.
- **Stops and optimization** — add intermediate waypoints, and ask the engine to
  reorder them into the shortest trip while keeping the first and last fixed.

:::note Transit has its own options
The "prefer modes," "fewer transfers / less walking," wheelchair-accessible, and
Deutschlandticket-only controls belong to transit journey planning, not
ground routing. See [Public transit](./public-transit.md).
:::

## Elevation

For cycling and walking routes, Valhalla samples elevation at regular intervals
along the path. The app turns those samples into an elevation profile: a chart of
the terrain plus summary stats — total ascent, total descent, the maximum
elevation, and the average grade. Hovering the chart highlights the matching
point on the map, and the profile auto-expands for non-driving routes where the
climb is significant. Elevation requires Valhalla (OSRM does not provide it) and
follows your metric/imperial unit setting.

## Turn-by-turn navigation

Once you have a driving, cycling, or walking route, you can start turn-by-turn
navigation directly in the browser — no app install. Navigation uses your
device's location to follow your progress along the route and shows, in real
time:

- a **maneuver banner** with the next turn, its distance, and a direction icon;
- **lane guidance** at junctions that have it, dimming the lanes you should not
  take and brightening the one to follow;
- a **speed-limit badge** when the road's limit is known;
- an **arrival card** with the remaining distance and estimated time of arrival.

Navigation also speaks instructions aloud (voice guidance can be toggled off) and
offers a **keep-screen-on** option that holds a wake lock so the display does not
sleep while you drive. If you leave the route, OpenMapX **reroutes
automatically** from your current position; when a reroute can't be computed it
surfaces a brief notice rather than failing silently. A recenter control snaps the
camera back to follow mode after you pan away to look ahead.

Under the hood, the engine's per-step maneuvers, lane data, and speed limits are
normalized into a single shape regardless of which engine produced them, so the
navigation UI behaves the same on Valhalla and OSRM. Valhalla additionally backs a
map-matching endpoint that snaps a recorded GPS trace to the road network — used
for features such as placing traffic-signal markers along the active route.

## Flights: a deep-link, not live data

Selecting the **flying** mode does not route an air leg or fetch live flight
data. OpenMapX has no flight feed; instead, the flights integration is a set of
**deep-link builders**. It takes your trip — origin and destination airports,
dates, passengers, cabin class, and a direct-only preference — and constructs a
pre-filled search URL for an external flight engine, then opens it in a new tab.

- The panel resolves the **nearest airport** to your directions origin and
  destination automatically, and lets you change either one. (Airport lookup is
  powered by a separate open-data integration, not the flights integration
  itself.)
- You pick which **search engine** to open — Skyscanner, Google Flights, KAYAK,
  Kiwi.com, momondo, or Skiplagged — with one preselected by configuration. The
  UI dims any input a given engine can't carry into its URL, so you know what
  will and won't transfer.
- Because it is a link-out, the flight engine you choose is the one that sees
  your search, not your OpenMapX server. These are third-party sites with their
  own privacy terms.

This keeps long-distance trip planning useful without taking on a commercial
flight-data feed.

## Configuration

You rarely need to touch routing internals — enabling an engine service is
usually all it takes. Routing engines are backend **services**; enable and run
them with the `openmapx` CLI:

```bash
pnpm openmapx services enable valhalla        # planet-capable, all three modes
pnpm openmapx services enable osrm            # fast region-only driving (optional)
pnpm openmapx services start --preset routing # bring up the routing stack
```

Both engines need prepared data built from an OpenStreetMap extract before they
can serve — see [Managing services](../install/managing-services.md) for
enabling, building, rendering, and running services, and
[Configuration](../install/configuration.md) for the `.env` and admin-panel
settings.

The engine integrations expose a small set of operator settings through their
manifests and the admin panel:

- **Valhalla** (`routing-valhalla`) — an endpoint URL and optional API key. Left
  blank, it resolves a self-hosted `valhalla` service via the routing-engine
  capability; you can also point it at a hosted Valhalla-compatible endpoint.
- **OSRM** (`routing-osrm`) — an endpoint URL. Left blank, it resolves a
  self-hosted `osrm` service, or falls back to the public OSRM demo (rate-limited
  and intended for evaluation, not production).
- **Flights** (`flights`) — the default search engine to preselect, and an
  optional Skyscanner affiliate id.

For the engine-specific build and tuning details (elevation and admin-boundary
toggles, region builds, memory needs), the project wiki's **Valhalla** and
**OSRM** pages go deeper than this feature overview.

## Related features

- **[Search](./search.md)** — find the places you route between.
- **[Public transit](./public-transit.md)** — journey planning by bus, train,
  and tram.
- **[Map layers](./map-layers.md)** — traffic, satellite, and other overlays you
  can switch on while planning a route.
