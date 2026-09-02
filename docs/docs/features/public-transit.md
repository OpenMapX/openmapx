---
title: Public transit
description: Door-to-door public-transit journey planning, departures, route preferences, and live vehicles — backed by a MOTIS-first chain of self-hosted and regional providers.
sidebar_position: 4
---

# Public transit

OpenMapX plans public-transit journeys the way a rider thinks about them:
"how do I get from here to there, leaving now, by bus and train?" It answers
with door-to-door itineraries — walking to the stop, the transit legs in
between, the transfers, and the walk at the far end — alongside live departure
boards, route preferences, real-time vehicle positions, and guided transit
navigation.

The transit feature spans three things you can see in the app:

- **Journey planning** — multi-leg trips between two points, with departure or
  arrival times, transfer counts, leg geometries, and (where the data supports
  it) fares.
- **Departures and arrivals** — a live timetable for any stop, with platform
  numbers, delays, and cancellations, plus per-route and per-stop service
  alerts.
- **Live vehicles** — moving trains, trams, and buses on the map, drawn from
  real-time feeds.
- **Transit navigation** — walking guidance to and between stops, live ride
  progress, transfer risk, alerts, and a get-off reminder.

Under the hood, all of this is served by a **transit orchestrator** that queries
many providers and merges their results. The rest of this page explains how that
chain is put together, what the route options do, and how an operator configures
which providers run.

## Planning a journey

Switch the [directions](./directions.md) panel to the transit tab and OpenMapX
plans a trip between your origin and destination. Each itinerary is a sequence of
legs — walk, ride, transfer, ride, walk — with per-leg duration, the line and
its color, the boarding and alighting stops, and the geometry drawn on the map.
The panel shows several alternatives so you can trade a faster trip against fewer
transfers or less walking.

Cards preserve operational details rather than flattening them away: line
branding and vehicle identity, destination/headsign, platform and indoor level,
scheduled versus real-time times, occupancy, bike and wheelchair information,
service alerts, skipped stops, and cancellations appear when the provider sends
them. Tight transfers are flagged with interchange guidance so an attractive
headline duration does not hide a risky connection.

Trip planning is anchored on a **departure time** (leave now, or at a chosen
time) or an **arrival time** (be there by). The planner can also weave in a
first-and-last-mile mode — walking by default, or your own bike, a shared
bike/scooter, or a park-and-ride car leg — so a bike-plus-transit or
drive-to-the-station option appears next to the pure transit itineraries.

**Trips that cross a time zone** are labelled rather than silently converted.
Departure is shown in the origin's local time and arrival in the destination's,
each with a `UTC±N` chip and a note that the arrival is in destination local
time, so the printed span always matches the stated duration. A trip whose ends
share a UTC offset is left exactly as it was — crossing a border without changing
the clock adds no annotation.

### Route options

A "Route options" control mirrors the choices you'd expect from a consumer maps
app. They fall into three groups:

- **Prefer** — restrict the journey to specific vehicle categories: bus, subway,
  train, or tram. This is an allow-list, so checking Bus and Train returns only
  bus and train itineraries; with nothing checked, every mode is fair game.
- **Routes** — a single optimization target. *Best* keeps the engine's own
  ranking; *fewer transfers* and *less walking* re-rank the alternatives the
  engine returned; *wheelchair* switches the walking legs to a step-free
  (accessible) pedestrian profile.
- **Deutschlandticket** — a Germany-only toggle that constrains the journey to
  the local and regional services the Deutschlandticket covers, hiding
  long-distance trains (ICE/IC), long-distance coaches, and night trains. It's a
  vehicle-category approximation of the ticket's scope, matching the "local
  transport only" filters you'll find elsewhere.

The Prefer modes and the Deutschlandticket filter are applied by the routing
engine itself, so they genuinely change which connections come back. *Fewer
transfers* and *less walking* are applied to the returned set — the engine
already computes a multi-criteria spread of alternatives, so OpenMapX re-orders
that spread rather than asking for a narrower search that might come back empty.

### Journeys with intermediate stops

A journey can carry stops between its ends, each with its own time and dwell.
OpenMapX plans one connection per segment and hands the previous segment's real
arrival to the next as its departure, so a delay carried into a leg shapes what
it can catch. That delay is shown on the leg it belongs to, alongside the
scheduled time it drifted from.

A chained journey has no combined earlier/later paging: each leg has its own
alternatives, because there is no single cursor that means the same thing across
all of them. When a leg has no connection at all the chain stops there and says
so, keeping the part of the schedule it did work out.

## Departures, stops, and alerts

Open any stop or station and OpenMapX shows a live departure board: the next
departures with their lines, destinations, scheduled and real-time times, delays,
platform or track, and cancellations. The same surfaces back stop-detail views in
[places](./places.md) — search a station and you get its departures, the lines
that serve it, and, where a provider exposes it, station infrastructure
(elevators, platforms, facilities) and service alerts.

Scheduled times come from the matching provider's timetable; real-time deltas —
the actual delay, a platform change, a cancellation — are merged in on top from
any real-time provider that covers the area. When the underlying provider already
returns real-time-aware times (MOTIS does this natively from GTFS-RT), OpenMapX
skips the redundant second lookup.

## Live vehicles on the map

A live-transit map overlay plots vehicles in motion — trains, trams, and buses
moving through the current view — refreshed as you pan. Positions come from the
real-time feeds that publish them: MOTIS surfaces the active trips for the
visible area, and regional sources add their own live positions where they're
configured (Germany's DB real-time feed, for example). See
[map layers](./map-layers.md) for turning the overlay on.

## Transit navigation

Start navigation from an itinerary to turn the plan into a live sequence of
walk, wait, ride, transfer, and arrival phases. Walking legs use turn-by-turn
instructions. At a stop, the app shows live boarding departures; aboard a
vehicle it follows the trip stop by stop, refreshes the itinerary, shows the
vehicle around you on a radar-style map, and surfaces platform changes,
cancellations, occupancy, and service alerts as they arrive.

The ride sheet can be swiped through upcoming stops and keeps scheduled and
real-time values distinct. Transfer cards show the next line, platform, walking
handoff, and connection risk; when a connection becomes endangered the app can
offer alternatives. Indoor level guidance is retained where station data
contains it. Voice cues, a keep-screen-on setting, and an optional get-off alarm
(including a background notification where the browser permits it) help when
the map is not in hand. The arrival summary closes the trip cleanly.

While planning or navigating transit, the live-vehicle and transit-line overlays
turn on automatically if available. Manually enabling or disabling either layer
is respected, and an automatically enabled layer returns to its earlier state
when the transit context ends.

## How the orchestrator works

No single transit data source covers the world well. A planet-scale engine is
unbeatable for door-to-door routing across hundreds of feeds, but a national
operator's own API often knows things that aggregated GTFS doesn't — live
platform changes, occupancy, the exact quirks of its network. OpenMapX's
orchestrator embraces that by keeping a **chain of providers**, each declaring
the geographic area it covers and a priority, and dispatching to them in order.

The model is **MOTIS-first**. [MOTIS](https://github.com/motis-project/motis) is
OpenMapX's primary transit engine: a single self-hosted server that imports an
OSM extract plus hundreds of GTFS feeds and answers multi-modal journey, stop,
and departure queries at scale. It sits at the top of the chain with worldwide
coverage, so most journeys are planned by your own MOTIS instance. Specialized
regional and agency providers slot in just below it for the places where they
add value, and broader catalogs sit underneath as a long-tail fallback.

Concretely, when a request comes in the orchestrator:

1. collects every registered transit provider whose coverage area overlaps the
   request;
2. sorts them by priority (lower number wins);
3. for a journey plan, tries each in turn and returns the first that produces a
   usable itinerary; for fan-out queries (stops in an area, vehicle positions,
   alerts) it queries the matching providers in parallel and merges, de-duplicating
   stops that appear in more than one feed.

The priority tiers look like this:

| Priority | Providers | Role |
| :---: | --- | --- |
| 1 | Self-hosted MOTIS (`transit-motis-local`) | Primary backbone and the only compiled static-schedule runtime — planning, stops, timetables, routes, and departures. |
| 1–3 | Regional / agency providers (Entur, MBTA, TfL, iRail, opentransportdata.ch, DB HAFAS/vendo, DB RIS routing, …) | National operators with quirks or live data MOTIS doesn't model, each scoped to its country/city. |
| 5 | Dynamic registry | A community-curated catalog of agency APIs. |
| 7 | MOTIS via Transitous (`transit-motis-transitous`) | Always-on soft fallback — covers local-MOTIS restarts and cold starts. |
| 9 | Transitland | Global catalog for areas beyond MOTIS coverage. |
| 10 | Overpass (OSM) | OSM-derived stops only; opt-in fallback, off by default. |

The self-hosted MOTIS provider also falls back to the hosted
[Transitous](https://api.transitous.org) service automatically when your local
instance is unreachable, so transit keeps working during a MOTIS rebuild or
restart.

### The dynamic registry

The dynamic-registry provider pulls a community-maintained catalog of public
transit APIs and registers each one as a provider on the fly, giving long-tail
coverage of agencies that have a public endpoint but no first-party integration
in OpenMapX. It's the catch-all between the hand-built regional providers and the
global catalogs — entries it would duplicate (where a dedicated provider already
exists) are suppressed.

### Where the timetable data comes from

MOTIS is the only component that compiles and serves static schedules. The
data-manager builds its requested source set from the pinned
[Transitous](https://github.com/public-transport/transitous) catalog plus any
operator sources, acquires and validates the archives, imports them into an
inactive MOTIS slot, runs functional probes, and then promotes the complete
candidate. Postgres stores source, job, validation, and promotion metadata—not
GTFS schedules.

Catalog sources can be disabled and re-enabled. An operator source must provide
a region, safe name, URL, attribution, and an SPDX license identifier or license
URL. These changes are asynchronous, so the requested set can differ from the
active set. A failed candidate never replaces the prior live dataset. See
[Preparing data](../install/preparing-data.md) for the lifecycle and
[How it works](../overview/how-it-works.md) for the data-manager that owns it.

Stop timetables use the stop's local civil day. Route-pattern IDs are tied to
the active dataset epoch and must not be persisted as durable external IDs.
Route details currently depend on the experimental MOTIS
`/api/experimental/map/route-details` endpoint in the pinned MOTIS release.

Real-time data (GTFS-RT, plus agency-specific live APIs) is layered on top of the
schedules by the real-time providers, scoped to the regions they cover.

### Resilience and health

Every provider call is timed and recorded into a sliding health window. A
provider that starts failing is automatically taken out of rotation for a short
cooldown, so one flaky upstream degrades gracefully to the next provider in the
chain instead of failing the whole request — and recovers on its own when it
comes back. Operators can inspect per-provider health and reset a cooldown from
the admin surfaces; [Monitoring](../administration/monitoring.md) documents the
window parameters and metrics.

Every result also carries **attribution** for the feeds and operators behind it,
which OpenMapX de-duplicates and renders as data-source credits in the UI.

## Configuring transit

Transit has two configuration surfaces, matching OpenMapX's
[service / integration split](../overview/how-it-works.md).

### The transit engine (a service)

Running your own MOTIS is a [service](../install/managing-services.md) decision.
Enable it, build its prepared data for your region, and link it into the stack:

```bash
pnpm openmapx services enable motis
pnpm openmapx data download osm europe/germany
pnpm openmapx data sync --countries de,at,ch
pnpm openmapx services start motis
```

MOTIS scales from a single country to the whole planet on one server — pick the
smallest region that covers your users, since region size drives RAM, disk, and
import time. The region-only alternative,
[OpenTripPlanner](../guides/transit-engines.md), is
also supported for smaller deployments. See
[Managing services](../install/managing-services.md) and
[Preparing data](../install/preparing-data.md) for the full lifecycle, and
[Configuration](../install/configuration.md) for the `MOTIS_URL` and
`MOTIS_REGION` knobs.

### The transit providers (integrations)

Which transit providers participate, and any credentials they need, is managed
per integration in the admin panel at `/admin/integrations`. Most regional and
agency providers work with no key at all; the few that require an API key (some
real-time feeds) take it there, with the usual rule that anything set in
`infra/docker/.env` wins over the admin-stored value. See
[Configuration](../install/configuration.md) for the environment-variable side.

A handful of providers are deliberately off until you opt in — the OSM-derived
Overpass fallback, for instance, is enabled only when its environment flag is
set, since it returns stop geometry without schedules and is meant strictly as a
last resort.

## Related features

- [Directions](./directions.md) — the routing panel transit shares with driving,
  walking, and cycling.
- [Places](./places.md) — stop and station detail, with departures and lines.
- [Map layers](./map-layers.md) — the live-transit and transit-line overlays.
- [Mobility data](./mobility-data.md) — shared bikes, scooters, and cars that
  feed first-and-last-mile legs.
