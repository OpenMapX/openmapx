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

### Regional and local alternatives

For point-to-point journeys using MOTIS or Transitous, an unrestricted search
can include regional/local connections alongside faster long-distance trains.
When the results include a long-distance train and your allowed modes include
regional/local transport, OpenMapX makes one additional bounded query to the
same provider. Both searches keep your time, access modes and other requirements.
A regional query failure leaves the primary results available.

**Regional/local** describes the services used; it does not establish a fare or
validate a Deutschlandticket. The results are useful alternatives, not a list of
every departure. Earlier/later pages retain each search's own timetable cursor.
Chained journeys and refresh replanning do not run the extra search.

In connection details, alternatives show their train name and departure–arrival
times. A selectable alternative replaces its complete access, ride and transfer
legs. The original journey remains available. A composed alternative has no
inherited fare or refresh identity; a matching complete result keeps its own.
Your selected connection survives background refreshes of the same search.
Changing the endpoints or routing requirements retires composed alternatives.

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

A place's board includes the stops within 1 km whose name is the place's name.
Sources spell it differently, with or without the town ("Neumarkt", "Köln
Neumarkt", "Marienplatz, München"). It also includes stops whose name says
they belong to the station, such as "Köln Dom/Hbf" at Köln Hauptbahnhof or
"S+U Alexanderplatz Bhf/Gontardstr." at Alexanderplatz. A stop that only shares
the district is left out: "Köln Deutz Suevenstr." is not on the board for
"Köln Messe/Deutz". Some bus stops beside a station are left out too, when
their name doesn't say they belong to it.

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

When sources give one departure different platforms, the board shows the
platform most sources give: some timetables number a station's platforms
differently from its signs. A platform change one source reports is shown when
it moves the departure off the platform most sources plan.

### Understanding timetable status

**Scheduled time** identifies explicitly timetable-only service. A prediction
can show a different time, including an early departure. Missing freshness
information does not establish that a prediction is current.

**Times may have changed** warns about known outdated predictions: the source's
realtime data was more than 90 seconds old when OpenMapX fetched it. Only some
sources state when they last updated their realtime data: HAFAS-based regional
sources and Transport for London do. MOTIS/Transitous, Entur, OTP-based sources
and the Swiss timetable do not, and a board that combines
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

Navigation keeps the connection you selected. Walking legs show turn directions
and the upcoming line, destination sign, departure, boarding stop and platform.
Off-path walking directions can be updated to the same stop without changing any
ride. For wheelchair journeys, use **Find alternatives** instead: the transit
planner keeps the accessibility requirement that a general walking router cannot
establish.

Confirm **I'm on board** once you board the selected service. GPS alone cannot
tell which vehicle you took at a shared stop. During the ride, your location dot
and the follow camera show your actual admitted GPS position. The current ride
summary and expanded stop list use the same ordered stop progress. If the route
shape and your location disagree, progress is marked uncertain. The connection
stays selected. Without GPS, the last known position and current leg remain in place.
A timetable never moves your dot, boards you, or finishes a ride.

The route strip opens the journey sheet for the service's destination sign,
vehicle and operator details, and stop times. End and the arrival summary stay
visible while the details scroll. When long text leaves too little room for a
summary, the compact route strip expands to show the boarding controls and details.
Stop-count controls reveal intermediate or
previous stops. The boarding, next and alighting stops stay listed, along with
skipped stops and service notices. When riding progress is uncertain, upcoming
stops remain expanded and the summary labels its next stop as last known.

Confirm **I've got off** after alighting to start the next walk or boarding leg.
You can undo the last confirmation for two minutes. Where the itinerary explicitly
continues on the same vehicle, **Stay on board** continues to the next leg. A
reminder can prompt you to confirm a forgotten boarding or alighting action; it
does not act on your behalf. Getting off elsewhere keeps recovery and alternatives
available. The final walk finishes when you reach the destination area. In the
installed app, location tracking stops a few seconds after arrival, or once the
last confirmation can no longer be undone if that is later.

A departure time in the past is a reason to check your service, not proof you
missed it. Delays, platform changes, cancellations, and tight transfers remain
visible. **Find alternatives** compares journeys without replacing yours. While
riding, it previews options from the planned alight stop at the expected arrival
time. After alighting, search from your fresh actual position and choose
**Use this journey** to change connections. Failure or dismissal keeps the current
journey. Your transit requirements also apply to the alternative search.

Scheduled times, live predictions, rider location and captured stop information
have separate meanings. Missing live data or stop counts is stated explicitly.
Get-off alerts are aids, not a guarantee: GPS, source coverage and operating-system
permissions can all affect delivery. The installed app arms its scheduled backup
only while you have confirmed being aboard; that backup is labeled as a time
estimate. Browser voice and notifications depend on the page's lifecycle.

Browser navigation survives component remounts but ends on a full page reload.
The installed app persists its own session, including confirmed phase and stop
progress. An older installed app that lacks the new rider controls needs an update.

Detailed stops and vehicle overlays can accompany the journey when available.
Manual layer choices remain respected. See the [navigation contract](../developer/transit-navigation.md)
for the shared engine and native authority boundaries.

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

**Admin → Transit** reads the `transit-sync` jobs that scheduled and manual syncs
create. The last sync shows the latest finished run. A queued, running or
cancel-pending run appears as the current job, and the job list shows
`transit-sync` runs unless another `kind` is requested.

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

## Passenger platform evidence

Journey details and navigation can supplement DELFI timetable platforms with
Rhein-Ruhr SIRI ET assignments when the instance enables **DELFI SIRI ET**.
The community mirror integration is opt-in: its service-use terms and
availability are not guaranteed. It works with hosted Transitous and local MOTIS;
it does not require changing planners. Coverage is limited to matching complete
journeys in that regional feed. Planning cards do not receive this enrichment.

Assignments retain separate arrival/departure values and source record times.
A published schedule or source correction does not trigger a platform-change
warning. Fresh realtime assignments can do so; platform sections such as `5 A-C`
are preserved. Missing data stays unknown. Five verified incorrect DELFI
station/code pairs are withheld until an independent assignment is available.
Other high platform numbers remain valid.

A temporary refresh failure keeps the selected journey and retries. The server
can replay a successful response for two minutes when its first response is
lost. If a lost response cannot be replayed within that window, the itinerary
refresh chain stops; captured vehicle journeys continue polling. A fallback plan
requires rerouting; navigation never silently applies a different train.
