---
title: Public transit
description: Plan journeys, check departures and service alerts, and follow a transit itinerary.
sidebar_position: 4
---

# Public transit

Use transit in [Directions](./directions.md) to plan a trip with walking,
boarding, transfers, and arrival at your destination. Open a station to check
its departure board, or enable **Live transit** in Layers to see available
vehicle positions.

Coverage depends on the instance's prepared timetable data and enabled hosted
or regional providers. A timetable is not a promise of live predictions,
vehicle positions, fares, accessibility, or service on every route.

## Planning a journey

1. Open **Directions** and choose the transit mode.
2. Set the origin and destination. Choose to leave now, depart at a time, or
   arrive by a time.
3. Review the alternatives, including walking, transfer time, platforms, and
   any alerts. Select an itinerary to inspect its legs.
4. Start navigation when ready, with device location permitted.

Cards show scheduled and predicted times separately when the source supplies
both. Line branding, headsigns, occupancy, bicycle information, accessibility,
indoor levels, fares, and skipped stops depend on the provider. Tight transfers
can be flagged; confirm important connections with the operator.

Trips whose endpoints have different UTC offsets show departure in the origin's
local time and arrival in the destination's local time, with offset labels.

### Route options

| Option                         | Effect and limit                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Vehicle categories             | Restricts supported planner requests to selected modes, such as bus or train; an empty selection allows all modes                     |
| Fewer transfers / less walking | Ranks the alternatives returned by the planner; does not guarantee the best possible journey across all services                      |
| Wheelchair                     | Requests an accessible pedestrian profile and supported accessibility constraints; missing source information remains uncertain       |
| Deutschlandticket              | Approximates the ticket's scope using local/regional vehicle categories; it does not verify ticket validity for an individual service |
| Access and egress              | Where supported, adds walking, your bicycle, rental mobility, or a park-and-ride leg                                                  |

Additional controls depend on planner capabilities, including transfer buffers,
maximum transfers, bicycle carriage, and rental filters. An unsupported required
capability can make a request unavailable. Try removing optional restrictions
when no journey is found, while keeping any accessibility requirement you need.

### Journeys with intermediate stops

Intermediate stops can carry times and a dwell duration. OpenMapX plans the
segments in order, carrying the preceding arrival into the next segment. Review
each segment's alternatives and transfer feasibility. A chain has no single
combined earlier/later paging cursor. If a segment has no connection, the
remaining chain cannot be completed.

## Departures, stops, and alerts

Open a stop or a place with linked stops to see its available departures,
arrivals, lines, facilities, and alerts. Platform numbers, changes,
cancellations, and predicted times appear only when reported.

Scheduled data comes from the stop's source. Compatible realtime providers can
add updates; sources that already include realtime times do not need a second
lookup. Similar station names alone do not make different source IDs
interchangeable.

A place's board starts by searching its stops by name. It uses the place's name
in its own language from OpenStreetMap, because transit sources name stops
locally: a station shown as "Munich Central Station" is searched as "München
Hauptbahnhof". A stop you opened, from search or a planned journey, is searched
by its own name too. If a stop source does not answer, the board warns that
departures may be missing instead of showing an empty board, and the place is
looked up again within about a minute. If no source answers, the board shows a
failure with a retry action. Departures that cannot be loaded for some of the
place's stops get the same warning. Lines, alerts and facilities that cannot be
loaded are left out rather than kept as "none", and are loaded again on a later
visit or within about a minute.

A place's stops can have different names, for example a main station and a bus
stop beside it. A departure from a stop other than the place's main one shows
that stop's name next to its line, so you know where to board. When you open a
stop from search, the map or a planned journey, that stop is the main one;
otherwise it is the stop named like the place. Different spellings of one name,
such as "Köln Hbf" and "Köln Hauptbahnhof", count as one stop and are not
labelled.

Lines appear under the name riders know, such as "S11" or "RE1". Some sources
write the train number or their operator into the line's name ("DB S11
(Zug-Nr. 33192)"); the number then appears in the trip's details instead. A
train that two sources, or one source twice, list under different spellings
shows as one departure.

### Understanding timetable status

**Scheduled time** identifies explicitly timetable-only service. A prediction
can show a different time, including an early departure. Missing freshness
information does not establish that a prediction is current.

**Times may have changed** warns about known outdated predictions: the source's
realtime data was more than 90 seconds old when OpenMapX fetched it. Only some
sources state when they last updated their realtime data: HAFAS-based regional
sources and Transport for London do. MOTIS/Transitous, Entur, OTP-based sources,
the Swiss timetable and DB's own interface do not, and a board that combines
sources only has an age when every realtime source on it states one. The absence
of this warning therefore does not prove freshness.

Platform changes show planned and current values when available; cancellations
retain a clear label and struck-through times.

If a refresh fails, previously loaded times can remain with a warning and retry
action. A partial linked board warns that departures may be missing. A
successful empty board means its source returned no departures; it does not
prove that every source or nearby station has no service.

## Live vehicles on the map

Enable **Live transit** in [Layers](./map-layers.md). Vehicle positions depend on
available feeds and can be delayed or absent. Seeing a scheduled service on a
departure board does not mean the map can track its vehicle.

## Transit navigation

Navigation follows walking, waiting, riding, transferring, and arrival phases.
Where data is available, it shows boarding departures, upcoming stops, platform
changes, connection risk, cancellations, and alerts. Walking instructions and
indoor guidance depend on the itinerary's geometry and station information.

Stop arrival uses mapped platform or station areas when available, with a
fallback area around the stop. Device accuracy and mapping can affect when a
phase changes; check that the selected stop and platform are correct.

Voice guidance, a keep-screen-on setting, and an optional get-off alarm support
the trip. Background notifications depend on browser permission and lifecycle.
The alarm is suppressed before boarding and for cancelled legs. Do not rely on
it as your only indication of where to leave the vehicle.

Transit lines and live vehicles can turn on automatically during planning or
navigation. Manual layer choices are respected, and automatically enabled
layers return to their earlier state when the transit context ends.

## How the orchestrator works

The transit integration selects providers by declared coverage, role,
capabilities, health, and source policy. Baseline planning is tried before
regional and fallback providers. Within a role, lower numeric priority is tried
first. A successful baseline response with no itinerary is authoritative and
can stop the chain; it does not automatically trigger a hosted search.

The built-in `transit-motis` integration registers local MOTIS when configured.
Without a local endpoint it can use hosted Transitous as the baseline. With a
local endpoint, Transitous can be a separate fallback. This is subject to
`hostedRuntimeFallback`, the operations profile, and source policy; hosted
fallback is not an availability guarantee.

Regional providers include Entur, MBTA, TfL, iRail, Swiss transport, and German
rail adapters. Catalog integrations have narrower roles: Transitland and
Overpass can supply stop discovery without a complete journey-planning service.
Mobility Database supplies feed catalog metadata, not departures or journeys.

### The dynamic registry

The dynamic registry discovers agency APIs from supported catalogs. Its endpoints
and credentials have their own requirements. A discovered endpoint does not
establish that an agency provides every transit operation or current data.

### Where the timetable data comes from

For local MOTIS, the data-manager prepares the selected feeds and OSM data,
imports an inactive candidate, validates it, and promotes it. Requested source
changes take effect only after successful publication. A failed candidate keeps
the prior live dataset. Follow [Preparing data](../install/preparing-data.md).

Timetables use the stop's local day. Internal route-pattern IDs belong to the
active dataset version and should not be treated as permanent external IDs.

### Resilience and health

Provider errors can trigger cooldown and eligible fallback. These mechanisms
cannot supply missing coverage, unsupported features, or an unavailable hosted
service. Source credits identify contributing feeds. Operators can inspect
[Monitoring](../administration/monitoring.md) and
[Transit integrations](../developer/transit-integrations.md) for dispatch and
freshness contracts.

## Transit reachability and isochrones

The **Travel time** tool can show estimated transit reachability when supported
by local MOTIS. Explore can use that estimate to filter nearby places. A smooth
map surface is an estimate, not an exact journey to every point inside it.

Exact destination checks and sampled downloadable GeoJSON polygons are separate,
operator-enabled capabilities. They require verified self-hosted MOTIS; those
requests do not send destination grids to Transitous. Sampled polygons still
have spatial resolution limits. See
[Transit reachability](../administration/transit-reachability.md) for setup,
costs, and interpretation.

## Configuring transit

### The transit engine (a service)

Operators who need local timetables should follow the
[transit engine guide](../guides/transit-engines.md) and
[Preparing data](../install/preparing-data.md). Configure coverage and source
licenses before building a dataset. Local endpoint configuration alone is not
proof that an active dataset and its capability metadata are ready.

### The transit providers (integrations)

Manage provider credentials and enablement under **Admin → Integrations**.
Review hosted Transitous use and fallback explicitly. The
[MOTIS operations profiles](../administration/motis-operations-profiles.md)
explain regional deployments and hosted fallback controls.

If no journey appears, check the date, covered region, required modes, and
restrictions. Operators should inspect provider health and the active dataset;
users should check the transport operator when service information is missing.

## Related features

- [Directions](./directions.md): route planning and stop times.
- [Places](./places.md): station details.
- [Map layers](./map-layers.md): transit line and vehicle overlays.
- [Mobility data](./mobility-data.md): shared mobility for access and egress.
