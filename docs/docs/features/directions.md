---
title: Directions & navigation
description: Traffic-aware road routing, EV charge planning, cycling and walking directions, turn-by-turn navigation, elevation, ride-hailing handoff, and flights deep-links.
sidebar_position: 3
---

# Directions & navigation

Plan driving, motorcycle, cycling, or walking routes, then follow them with
turn-by-turn navigation. [Public transit](./public-transit.md) has its own journey
planner. Ride and flying modes open external services for booking or search.

To plan a ground route:

1. Choose **Directions**, then set your origin and destination.
2. Select a travel mode. Add intermediate stops or change route options if needed.
3. Review the route, distance, duration, and any warnings. Select an alternative
   if the provider returns one.
4. Choose **Start** and allow device location for navigation.

The map sends routing requests to your instance's API, which calls the selected
routing provider. A provider can use a local engine or a configured hosted
endpoint. Some adapters have public hosted defaults, so a fresh instance does
not by itself keep route endpoints on the local server. Operators should review
[the routing engine configuration](../guides/routing-engines.md) and source terms.

## What you can do

- Add intermediate stops and optimize their order where no fixed stop times prevent it.
- Set leave-after, arrival, appointment, and dwell times for stops.
- Compare available alternatives and choose avoidance preferences.
- Inspect cycling or walking elevation when the engine supplies it.
- Plan EV charging stops using vehicle, charger, and tariff data.
- Navigate with spoken instructions, rerouting, and available lane/sign information.

Route duration, road suitability, traffic, charger availability, and accessibility
depend on source data and the selected engine. Review important restrictions
before travelling.

## How routing works

The routing integration tries compatible enabled providers in their configured
adapter order. The built-in priorities are BRouter 5, Valhalla 10, and OSRM 20.
An error can advance to the next compatible provider. Required capabilities,
including time-aware requests, can exclude a provider.

| Provider | Ground modes                          | Relevant limits                                                                                 |
| -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| BRouter  | Cycling                               | Prepared segment coverage and bicycle profiles; no public fallback endpoint                     |
| Valhalla | Driving, motorcycle, cycling, walking | Prepared local data or configured hosted service; supports timed routing and elevation sampling |
| OSRM     | Driving                               | Coverage and profile depend on its prepared dataset; follows Valhalla in the default order      |

Untimed cycling tries BRouter before Valhalla. Driving tries Valhalla before
OSRM. Running a compatible service does not establish that it has data for the
whole requested trip. Follow the [routing engine guide](../guides/routing-engines.md)
for setup and public endpoint limits.

### Travel modes

Choose driving, motorcycle, cycling, or walking for ground routing. Transit
uses the transit planner. Flying is a [link to an external search](#flights-a-deep-link-not-live-data).

Highway and toll avoidance apply to driving. Ferries and closures can also be
avoided for walking and cycling, subject to provider support.

### Cycling preferences

Cycling offers touring, road, mountain-bike, and gravel profiles, with preferences
for quieter roads, smoother surfaces, and avoiding hills. An explicit cycling
speed can affect route estimates where the provider supports it.

BRouter is tried first for untimed cycling, followed by Valhalla. BRouter has no
common smooth-surface or cruising-speed control, and some profile-specific
combinations are unsupported. In those cases its attempt fails so another
compatible provider can answer. A route estimate depends on the selected engine
and data; a bicycle profile does not certify that every segment is safe or
suitable for your equipment.

### Departure and arrival times

Use the leave-now / depart-at / arrive-by picker for driving and motorcycle
trips. Transit exposes its own time picker. Timed cycling and walking are also
available through the routing API.

Timed requests require a time-aware provider, currently Valhalla among the built-in
ground adapters. Incompatible engines are excluded instead of silently returning
an untimed route. Time-conditional access and predicted speeds still depend on
the engine's data. Untimed travel estimates do not gain time-of-day information
from stop-schedule arithmetic alone.

Supported road-condition schedules are evaluated at the selected travel time,
including recurring windows in the source's local time zone. A closure not yet
in effect need not cause the same detour as an active closure.

### Reading traffic information

Driving and motorcycle cards can show an estimated extra duration, such as
**(+12 min)**, beside a colored travel time. It compares the same path with and
without the engine's current traffic speeds. The caption appears when the
comparison is at least five minutes and 10% of the comparison duration.

Open **About traffic** for the estimate's source, road-update status, and limits.
Missing or unusable coverage leaves the normal duration color; **Traffic data
unavailable** appears in the details and screen-reader description. A positive
delay estimate does not establish complete fresh congestion coverage for every
road.

The interface supports a green duration when fresh, complete evidence confirms
that current congestion data was used and delay is below the display threshold.
The current built-in providers do not emit that coverage evidence, so a small or
zero comparison alone does not produce green.

Road-update verification is separate from estimated delay. It applies only while
matching engine and server evidence remains current. Map overlay colors also do
not establish that traffic was used in the route's duration. See the
[traffic layer details](./map-layers.md#transportation).

## Stop times and dwell

Any stop on a trip can carry a time of its own. The clock button on a waypoint
row opens four choices:

- **Leave after**: do not depart this stop before the given time. Arriving
  early simply means waiting.
- **Be there by**: a deadline for arriving.
- **Appointment at**: both at once. You arrive by that time, and you leave at
  the appointment plus however long you stay, so getting there twenty minutes
  early does not move your departure.
- **Time at this stop**: how long you stay, from zero minutes up to a day. It
  combines with any of the three above.

Dwell is never folded into the driving time. The route card keeps showing travel
time; a timeline underneath shows arrival, stay, wait and departure at every
stop, together with the whole-trip span and how much of it is spent standing
still.

Every time is local to the stop it belongs to. On a trip that crosses a
time-zone boundary or a daylight-saving change, each stop is shown on its own
clock, with the offset labelled wherever it differs from yours. A departure
written during the hour skipped by a spring-forward change resolves to the first valid instant after it.

If a schedule is impossible, OpenMapX identifies the missed deadline and shows
the best schedule it could calculate. Contradictions such as leaving one stop after a later deadline are reported
before any route is requested.

Stop order cannot be optimised while a stop has a set time, because reordering
could move you past an appointment. Clear the times, optimise, then set them
again. Stops that only carry a dwell still optimise normally: the total time
spent at stops is the same in any order.

## Route options

The directions panel exposes the tuning knobs that map onto the routing API:

- **Avoid**: highways and tolls (driving only), and ferries and closures (any ground mode).
- **Units**: kilometers or miles, a per-user setting that also controls how
  distances and elevation read throughout the app.
- **Alternatives**: returned automatically for a straight two-point trip (no
  intermediate stops). Each alternative is a selectable card; the chosen one is
  highlighted on the map.
- **Traffic-aware alternatives**: driving and motorcycle alternatives use the
  engine's live-traffic request when one is available. The result is graph- and
  request-dependent: the engine may return only the primary route when no
  distinct alternative satisfies its cost and safety filters. Baseline durations
  supply the same-path estimated traffic-delay comparison shown on route cards;
  they can legitimately be slower than the live route.
- **Stops and optimization**: add intermediate waypoints, and ask the engine to
  reorder them into the shortest trip while keeping the first and last fixed.

:::note[Transit has its own options]
The "prefer modes," "fewer transfers / less walking," wheelchair-accessible, and
Deutschlandticket-only controls belong to transit journey planning, not
ground routing. See [Public transit](./public-transit.md).
:::

### Sharing a route

Signed-in users can turn the current ground route (driving, walking, cycling,
motorcycle) into a revocable **share link**: the Share button offers "Create
share link" next to the classic copy-the-URL option.

The link preserves route inputs and calculates a new route when opened; it does
not preserve the exact geometry or a guaranteed travel time. It supports 2 to 10
waypoints, labels up to 200 characters, mode, highway/toll/ferry preferences,
and the shared cycling preferences. The current share dialog does not include
stop appointments or dwell times. Review the opened route before relying on it.

The dialog creates a non-expiring snapshot link. It counts against the account's
100 stored share links. Rotate or delete it under **Account settings → Shared
links** to revoke the old URL. Anyone with the URL can view the shared inputs.

## Elevation

Cycling and walking routes can include elevation samples along the path. The app turns those samples into an elevation profile: a chart of
the terrain plus total ascent, total descent, maximum elevation, and average grade. Hovering the chart highlights the matching
point on the map, and the profile auto-expands for non-driving routes where the
climb is significant. BRouter can return route elevation from its segment data; Valhalla provides
elevation sampling. OSRM does not provide elevation. The profile follows your metric/imperial unit setting.

## EV route and charge planning

EV is a driving submode. Choose a vehicle from the bundled Open EV Data catalog
(searchable by make) or enter a custom battery size, consumption, AC/DC charge
limits, taper point, and connector set. Then set starting charge, target charge
at stops, minimum arrival reserve, preferred or excluded charging networks, and
an optional home-energy price and currency.

The planner first computes the road route, searches charging sites along its
corridor, evaluates detours with a route matrix, and reroutes through the
selected stops. At each site it picks the charge point the vehicle would use: a
connector it plugs into, on a charge point that is in service (one a live status
reports out of order, or one still planned, is skipped), at the highest power,
and at equal power one that is free right now. It accounts for elevation and
temperature, the vehicle's charge curve and AC/DC limits, network preferences,
and live availability when the stop is reached soon after you plan; a status
past its validity never counts as free.

Price estimates use available tariffs for the selected connector, the station's
local time, session length, and energy amount. Applicable time windows, tiers,
VAT, and tariff minimum/maximum prices can affect the result. Ad hoc tariffs
are preferred when available. Parking time after charging is not included in the
planned stop. The result separates driving and charging time and shows estimated
energy, arrival charge, and cost only where the data supports them.

Check warnings for missing or partial charger sources, tight charge reserves,
and a lack of compatible stops. Selecting a charging stop opens its place card.
Availability can change before arrival; the estimate does not reserve a charger
or guarantee the price you will pay.

EV planning currently supports one origin and one destination; arbitrary user
waypoints are not accepted because the planner owns the charging stops. It
requires Valhalla routing plus a charging-site provider (OpenConditions);
without one the plan says no charger data is available instead of failing. Live
occupancy and tariffs depend on the feeds available in the trip region.

## Turn-by-turn navigation

Once you have a driving, cycling, or walking route, you can start turn-by-turn
navigation directly in the browser. Navigation uses your
device's location to follow your progress along the route and shows, in real
time:

- a **maneuver banner** with the next turn, its distance, and a direction icon;
- **interchange signage** on motorway exits: an exit-number badge, route shields
  in the sign colours of the country each exit is in (so a trip into Switzerland
  switches to green motorway signs at the border), and the toward destinations in the banner and directions list, using the engine's sign
  data;
- **lane guidance** at junctions that have it, dimming the lanes you should not
  take and brightening the one to follow;
- a **speed-limit badge** when the road's limit is known;
- an **arrival card** with the remaining distance and estimated time of arrival.

On the approach to any maneuver, the camera **tilts and closes in** so the turn
reads as a place, and an **arrow on the map** traces the route through the split.
Both revert automatically after the maneuver, and a pinch or drag during the
approach is never interrupted. Small speed changes keep the same maneuver in
focus; the emphasis resets when the maneuver passes, the route changes, or you
move back far enough to leave its approach.

The additional junction destination boards, schematic lane view and junction photos
are temporarily hidden while their quality is improved. Their settings controls are
also hidden. The green maneuver banner and its lane arrows remain available.
Junction lane lookups continue to supply those arrows, but navigation does not
search for, download or prepare junction photos. The implementation and saved
preferences are retained for future restoration.

Navigation also speaks instructions aloud (voice guidance can be toggled off) and
offers a **keep-screen-on** option that holds a wake lock so the display does not
sleep while you drive. If you leave the route, OpenMapX **reroutes
automatically** from your current position; when a reroute can't be computed it
shows a notice. A recenter control snaps the
camera back to follow mode after you pan away to look ahead.

A navigation menu keeps route overview, satellite view, contextual overlays,
directions, settings, and search-along-route within reach. Voice selection,
north-up/follow behavior, avoidance preferences, and screen wake-lock controls
are adjustable without abandoning the route. For a driving or motorcycle trip,
road conditions and self-hosted traffic flow switch on contextually; a manual
layer choice is respected and restored when the trip ends. Incidents ahead can
produce approach alerts, including confirmation/negation prompts for compatible
[crowd reports](./crowd-reports.md).

Navigation requires usable location fixes. Browser wake locks, speech, background
behavior, and connectivity depend on the device. Prepare
[offline coverage](./offline-maps.md) before losing connectivity; offline
continuation cannot calculate an arbitrary new route.

### Search for a stop along your route

Choose a category or chain from **Search along route** while navigating. Discovery
looks up to 25 km ahead within a 1,200 m geometric corridor. That cheap discovery
step does not prove road access: a nearby service area may be across a motorway
or river.

For a shortlist of six stops, OpenMapX compares the complete remaining itinerary
with and without each stop. **By road** labels show the extra routing time; the
card also shows extra distance. Both itineraries use the active mode, avoidance
preferences and routing provider. Existing user stops keep their order, and the
new stop is inserted before the next stop beyond its position on the route.

A known routing entrance is preferred when the place source supplies one.
Otherwise the card explicitly says it routes to place coordinates and the
entrance is unknown. A network estimate does not verify that a coordinate is an
entrance or that a business is open.

- **Straight-line estimate / ~**: only geometric distance and speed are available.
- **Checking**: the road comparison is pending.
- **Unavailable / unknown**: the provider failed, returned unusable data, or could
  not honor the pinned routing request.
- **No route / unreachable**: the provider returned no route through that stop.
  Adding it is disabled.

Estimates expire after 60 seconds and are removed when the route, provider,
preferences, or search changes. Small movements can reuse a rounded route
position, so an estimate is not recalculated for every location fix.

**Add** replans from the current position using the same insertion rules. **Cancel**
can dismiss a pending selection; a late response cannot change a newer route or
navigation session. This uses the existing routing configuration and adds no
admin setting.

## Flights: a deep-link, not live data

Selecting the **flying** mode does not route an air leg or fetch live flight
data. OpenMapX has no flight feed; instead, the flights integration is a set of
**deep-link builders**. It uses origin and destination airports,
dates, passengers, cabin class, and a direct-only preference to construct a
pre-filled search URL for an external flight engine, then opens it in a new tab.

- The panel resolves the **nearest airport** to your directions origin and
  destination automatically, and lets you change either one. (Airport lookup is
  powered by a separate open-data integration, not the flights integration
  itself.)
- You pick which **search engine** to open: Skyscanner, Google Flights, KAYAK,
  Kiwi.com, momondo, or Skiplagged, with one preselected by configuration. The
  UI dims any input a given engine can't carry into its URL, so you know what
  will and won't transfer.
- OpenMapX's API receives the selected inputs to construct the redirect. The
  external flight engine receives the fields it supports when your browser
  follows that redirect. It has its own privacy terms. OpenMapX does not fetch
  live flight schedules or prices.

## Rides

Choose ride mode to see the driving route and configured ride services for the
trip. Availability, supported handoff fields, and estimates vary by provider.

OpenMapX never books the ride. Choosing a provider opens their app or website, and
the fare, the vehicle and the booking are entirely theirs.

There are two kinds of provider:

- **Apps you hand off to** (Uber, Lyft, Bolt, FREENOW, Yango). No credentials, no
  data fetched: the link is built on your server when you click it. Some of these
  can carry your pickup and destination into the app and some publish no way to do
  so. The panel explains which trip fields will transfer.
- **Open on-demand feeds** in [GOFS](https://gofs.org/) format: taxi registries,
  microtransit and paratransit operators that publish their service areas, hours,
  wait times and fares openly. These can provide published coverage, wait times, and tariff-based estimates;
  they are not necessarily binding quotes.

Check these limits before opening a provider:

- **One provider at a time, by default.** Several ride-hailing providers' API terms
  forbid presenting them in a list beside competitors. An operator can enable
  comparison, and when they do, only providers whose terms permit it join the list.
- **"Estimated" means estimated.** A price with that label was computed from an
  operator's published tariff, not quoted by the service for your trip. A price
  without it came from the provider.
- **Quotes go stale.** They expire in about a minute. The panel counts down and
  fetches a fresh price the moment one lapses, but only while you are actually
  looking at it. Switching tabs or leaving it inactive for a few minutes stops
  automatic refresh. A Refresh link brings it back.
- For open feeds, OpenMapX processes pickup and destination on the server to
  determine coverage and estimates. App handoffs send their supported trip fields
  to the external service when you open the link. Review the selected provider's
  privacy information.

## Configuration

Operators configure engine services, prepared data, endpoints, and credentials
through the [routing engine guide](../guides/routing-engines.md) and
[Admin → Integrations](../administration/integrations-administration.md).

Valhalla can fall back to a hosted Stadia Maps endpoint and OSRM to its public
demo when no local service or explicit endpoint resolves. Those services have
their own credentials, terms, and limits. BRouter requires a local service or an
explicit endpoint. Review the effective endpoint rather than assuming an empty
setting means local-only routing.

Flight search and ride handoffs have separate integration settings. They do not
install a local flight or ride-booking service.

## Related features

- **[Search](./search.md)**: find the places you route between.
- **[Public transit](./public-transit.md)**: journey planning by bus, train,
  and tram.
- **[Map layers](./map-layers.md)**: traffic, satellite, and other overlays you
  can switch on while planning a route.
- **[Crowd reports](./crowd-reports.md)**: report or verify live conditions.
