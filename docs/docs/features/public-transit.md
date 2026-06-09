---
title: Public transit
description: Door-to-door public-transit journey planning, departures, route preferences, and live vehicles — backed by a MOTIS-first chain of self-hosted and regional providers.
sidebar_position: 3
---

# Public transit

OpenMapX plans public-transit journeys the way a rider thinks about them:
"how do I get from here to there, leaving now, by bus and train?" It answers
with door-to-door itineraries — walking to the stop, the transit legs in
between, the transfers, and the walk at the far end — alongside live departure
boards, route preferences, and real-time vehicle positions on the map.

The transit feature spans three things you can see in the app:

- **Journey planning** — multi-leg trips between two points, with departure or
  arrival times, transfer counts, leg geometries, and (where the data supports
  it) fares.
- **Departures and arrivals** — a live timetable for any stop, with platform
  numbers, delays, and cancellations, plus per-route and per-stop service
  alerts.
- **Live vehicles** — moving trains, trams, and buses on the map, drawn from
  real-time feeds.

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

Trip planning is anchored on a **departure time** (leave now, or at a chosen
time) or an **arrival time** (be there by). The planner can also weave in a
first-and-last-mile mode — walking by default, or your own bike, a shared
bike/scooter, or a park-and-ride car leg — so a bike-plus-transit or
drive-to-the-station option appears next to the pure transit itineraries.

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
| 1 | Self-hosted MOTIS (`transit-motis-local`) | Primary backbone — planet-scale planning, stops, departures. |
| 1–3 | Regional / agency providers (Entur, MBTA, TfL, iRail, opentransportdata.ch, DB HAFAS/vendo, DB RIS routing, …) | National operators with quirks or live data MOTIS doesn't model, each scoped to its country/city. |
| 5 | Dynamic registry, self-hosted GTFS feeds | A community-curated catalog of agency APIs, plus per-feed access to feeds you imported yourself. |
| 7 | MOTIS via Transitous (`transit-motis-cloud`) | Always-on soft fallback — covers local-MOTIS restarts and cold starts. |
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

MOTIS routes on GTFS feeds, and those feeds reach it one of two ways:

- **Self-hosted, via Transitous.** OpenMapX's data pipeline resolves a feed list
  from the community-curated [Transitous](https://github.com/public-transport/transitous)
  catalog, downloads the GTFS archives, and stages them for MOTIS to import. A
  daily sync keeps them fresh, with an atomic swap so a bad feed never takes down
  the running engine. See [Preparing data](../install/preparing-data.md) for the
  download-and-build workflow and [How it works](../overview/how-it-works.md) for
  the data-manager that owns it.
- **Your own feeds.** Point the pipeline at private operator URLs or a pinned
  subset, or import a feed directly into the database for the self-hosted GTFS
  provider. Either way it joins the chain without code changes.

Real-time data (GTFS-RT, plus agency-specific live APIs) is layered on top of the
schedules by the real-time providers, scoped to the regions they cover.

### Resilience and health

Every provider call is timed and recorded into a sliding health window. A
provider that starts failing is automatically taken out of rotation for a short
cooldown, so one flaky upstream degrades gracefully to the next provider in the
chain instead of failing the whole request — and recovers on its own when it
comes back. Operators can inspect per-provider health and reset a cooldown from
the admin surfaces; the project wiki's
[Transit Provider Health](https://github.com/OpenMapX/openmapx/wiki/Transit-Provider-Health)
page documents the window parameters and metrics.

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
pnpm openmapx data download gtfs --countries de,at,ch
pnpm openmapx services build motis --region europe/germany
pnpm openmapx services start motis
```

MOTIS scales from a single country to the whole planet on one server — pick the
smallest region that covers your users, since region size drives RAM, disk, and
import time. The region-only alternative,
[OpenTripPlanner](https://github.com/OpenMapX/openmapx/wiki/OpenTripPlanner), is
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
