---
title: Directions & navigation
description: Traffic-aware road routing, EV charge planning, cycling and walking directions, turn-by-turn navigation, elevation, ride-hailing handoff, and flights deep-links.
sidebar_position: 3
---

# Directions & navigation

Directions answer the most common map question: how do I get from here to there?
OpenMapX computes door-to-door routes for driving, motorcycle, cycling, and walking,
draws them on the map, and — for road travel — walks you through every turn with
in-browser turn-by-turn navigation. Public-transit journeys are planned by a
separate engine and have [their own page](./public-transit.md); this page covers
the ground-routing modes, EV planning, rides, and the flights deep-link.

Like everything else in OpenMapX, the routing here runs on infrastructure you
control. The map app talks only to your own API server, which proxies a routing
**engine** — by default a self-hosted one. No request reaches a third party
unless you point an engine at a third-party host.

## What you can do

- **Get a route** between two points, by car, bike, or on foot, with distance,
  duration, and a road-level summary (for example, "via A57").
- **Add stops.** A route can carry intermediate waypoints, and OpenMapX can
  reorder them into the shortest multi-stop trip.
- **Give a stop a time.** Leave after 10:00, be somewhere by 11:30, stay twenty
  minutes — OpenMapX plans the whole trip around it and says plainly when the
  schedule does not fit.
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
- **Hand off to a ride** — the ride mode shows the driving route, then the
  ride-hailing services available for it, with a wait time and price where the
  provider publishes one.
- **Plan an EV trip** with a real vehicle or custom battery specification,
  charging stops, state-of-charge targets, network preferences, energy use,
  charge time, and defensible price estimates.

## How routing works

Routing is built from small, replaceable pieces, the same plugin model as the
rest of OpenMapX (see [How it works](../overview/how-it-works.md)). The
`routing` integration is an **orchestrator**: it owns the API the app calls, but
does no path-finding itself. The actual work is delegated to a **routing
provider** — a thin adapter in front of a routing engine.

Two engine adapters ship in the box:

| Integration        | Engine    | Modes                       | Scale       | Extras                                                  |
| ------------------ | --------- | --------------------------- | ----------- | ------------------------------------------------------- |
| `routing-valhalla` | Valhalla  | driving, motorcycle, cycling, walking | planet | elevation profiles, departure/arrival times, map matching |
| `routing-osrm`     | OSRM      | driving                     | region only | very fast driving queries                               |

When the app requests directions, the orchestrator looks at the travel mode and
selects every provider that supports it, in registration order. It tries them in
turn, so if one engine is briefly unreachable the request falls through to the
next compatible one instead of failing. Each engine adapter is bound at startup
to a routing service through the `routing-engine` capability, falling back to a
configured endpoint when no local service is wired up.

The split between the two engines is deliberate:

- **Valhalla** is the general-purpose engine. It routes for all non-flying modes,
  handles planet-scale data, and is the only one that produces elevation
  profiles, honors departure/arrival times, and supports map matching. In a
  planet deployment, Valhalla handles everything — including driving.
- **OSRM** is a region-scoped, driving-only engine optimized for speed. Where a
  regional OSRM build is available, it answers car routes quickly; the chain
  still falls back to Valhalla when OSRM is absent or unavailable.

Because providers are selected by capability rather than hard-wired, a
deployment that runs only Valhalla still serves every routed ground mode; adding OSRM
simply gives driving a faster path. You choose which engines run by enabling the
corresponding services — see the [Valhalla and OSRM engine
guides](#configuration) below.

### Travel modes

The orchestrator accepts five UI modes for the directions panel: **driving**,
**motorcycle**, **cycling**, **walking**, and **flying**. Transit is intentionally
not routed here — a request for transit mode is redirected to the transit planner.
Flying is not a routed mode at all; it is a deep-link feature, described
[below](#flights-a-deep-link-not-live-data).

For driving, OpenMapX maps avoid options onto each engine's native vocabulary:
avoiding highways, tolls, and ferries on Valhalla, and the equivalent excludes on
OSRM. Highway and toll avoidance apply to driving; ferries and closures can be avoided on foot
and bike too.

### Departure and arrival times

The routing API can pin a route to a wall-clock **departure** or **arrival**
time, which Valhalla uses to honor time-conditional access (school zones,
time-restricted lanes, ferry schedules) and, where available, predicted speeds.
Engines that ignore time inputs are filtered out of the chain for a timed
request, so a pinned time never silently returns an untimed route. In the app,
the leave-now / depart-at / arrive-by picker is surfaced for transit journeys and
for the driving and motorcycle modes; the same time-aware capability is available
to cycling and walking through the API.

What a routing engine can honor here depends on the engine. A time-aware engine
(Valhalla) plans genuinely time-of-day-dependent legs and models a stop's service
time natively, so the hour you arrive at a later stop is costed for that hour. A
time-agnostic engine (OSRM) still produces a correct schedule — the arithmetic is
the same — but from travel times that ignore traffic and time of day, so the app
labels those times as estimates rather than hiding the difference.

When a timed route is requested, the routing system dynamically evaluates active
road closures. Planned closures are only avoided if they are actually in effect at the
selected travel time. The system evaluates these in the closure's local timezone (supporting
fine-grained recurring schedule windows). This prevents routing detours around
future closures that haven't started yet or nightly closures during daytime trips.

## Stop times and dwell

Any stop on a trip can carry a time of its own. The clock button on a waypoint
row opens four choices:

- **Leave after** — do not depart this stop before the given time. Arriving
  early simply means waiting.
- **Be there by** — a deadline for arriving.
- **Appointment at** — both at once. You arrive by that time, and you leave at
  the appointment plus however long you stay, so getting there twenty minutes
  early does not move your departure.
- **Time at this stop** — how long you stay, from zero minutes up to a day. It
  combines with any of the three above.

Dwell is never folded into the driving time. The route card keeps showing travel
time; a timeline underneath shows arrival, stay, wait and departure at every
stop, together with the whole-trip span and how much of it is spent standing
still.

Every time is local to the stop it belongs to. On a trip that crosses a
time-zone boundary or a daylight-saving change, each stop is shown on its own
clock, with the offset labelled wherever it differs from yours. A departure
written for a moment that does not exist — the hour a spring-forward skips —
resolves to the first valid instant after it.

An impossible schedule is not quietly rounded away. OpenMapX names the stop, the
deadline it misses and by how much, and still shows the best schedule it could
build so you can see where the time goes. Contradictions that need no routing to
spot — leaving one stop after you were due at a later one — are reported before
any route is requested.

Stop order cannot be optimised while a stop has a set time, because reordering
could move you past an appointment. Clear the times, optimise, then set them
again. Stops that only carry a dwell still optimise normally: the total time
spent at stops is the same in any order.

## Route options

The directions panel exposes the tuning knobs that map onto the routing API:

- **Avoid** — highways and tolls (driving only), and ferries and closures (any ground mode).
- **Units** — kilometers or miles, a per-user setting that also controls how
  distances and elevation read throughout the app.
- **Alternatives** — returned automatically for a straight two-point trip (no
  intermediate stops). Each alternative is a selectable card; the chosen one is
  highlighted on the map.
- **Traffic-aware alternatives** — driving and motorcycle alternatives use the
  engine's live-traffic request when one is available. The result is graph- and
  request-dependent: the engine may return only the primary route when no
  distinct alternative satisfies its cost and safety filters. Baseline durations
  are shown for comparison when supplied; a baseline can legitimately be slower
  than the live route.
- **Stops and optimization** — add intermediate waypoints, and ask the engine to
  reorder them into the shortest trip while keeping the first and last fixed.

:::note[Transit has its own options]
The "prefer modes," "fewer transfers / less walking," wheelchair-accessible, and
Deutschlandticket-only controls belong to transit journey planning, not
ground routing. See [Public transit](./public-transit.md).
:::

### Sharing a route

Signed-in users can turn the current ground route (driving, walking, cycling,
motorcycle) into a revocable **share link**: the Share button offers "Create
share link" next to the classic copy-the-URL option. The link stores only the
route *inputs* — waypoints, mode, and avoid options — so viewers always get a
fresh route from the routing engine, and it can be reset or deleted at any
time from **Account settings → Shared links**.

## Elevation

For cycling and walking routes, Valhalla samples elevation at regular intervals
along the path. The app turns those samples into an elevation profile: a chart of
the terrain plus summary stats — total ascent, total descent, the maximum
elevation, and the average grade. Hovering the chart highlights the matching
point on the map, and the profile auto-expands for non-driving routes where the
climb is significant. Elevation requires Valhalla (OSRM does not provide it) and
follows your metric/imperial unit setting.

## EV route and charge planning

EV is a driving submode. Choose a vehicle from the bundled Open EV Data catalog
(searchable by make) or enter a custom battery size, consumption, AC/DC charge
limits, taper point, and connector set. Then set starting charge, target charge
at stops, minimum arrival reserve, preferred or excluded charging networks, and
an optional home-energy price and currency.

The planner first computes the road route, searches compatible chargers along
its corridor, evaluates detours with a route matrix, and reroutes through the
selected stops. It accounts for elevation and temperature, the vehicle's charge
curve and connector limits, station power, network preferences, and live
availability when it is useful for a near-term trip. The result separates drive
and charge time and shows distance, estimated energy, arrival charge, and cost
only where the source data supports a meaningful price. Warnings explain missing
availability or tariff data, tight reserves, and cases where no compatible or
allowed network can make the trip. Selecting a charge stop opens its charger
place card.

EV planning currently supports one origin and one destination; arbitrary user
waypoints are not accepted because the planner owns the charging stops. It
requires Valhalla routing plus enabled EV-charging data sources. Live occupancy
and tariffs depend on the feeds available in the trip region.

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

A navigation menu keeps route overview, satellite view, contextual overlays,
directions, settings, and search-along-route within reach. Voice selection,
north-up/follow behavior, avoidance preferences, and screen wake-lock controls
are adjustable without abandoning the route. For a driving or motorcycle trip,
road conditions and self-hosted traffic flow switch on contextually; a manual
layer choice is respected and restored when the trip ends. Incidents ahead can
produce approach alerts, including confirmation/negation prompts for compatible
[crowd reports](./crowd-reports.md).

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

## Rides

The ride mode answers the question the other modes cannot: what if you do not have
a car here? Pick it, and OpenMapX computes the ordinary driving route — same engine,
same map — then shows who can drive you along it.

OpenMapX never books the ride. Choosing a provider opens their app or website, and
the fare, the vehicle and the booking are entirely theirs.

There are two kinds of provider:

- **Apps you hand off to** (Uber, Lyft, Bolt, FREENOW, Yango). No credentials, no
  data fetched: the link is built on your server when you click it. Some of these
  can carry your pickup and destination into the app and some publish no way to do
  so — the panel tells you which, rather than letting the destination vanish
  silently.
- **Open on-demand feeds** in [GOFS](https://gofs.org/) format — taxi registries,
  microtransit and paratransit operators that publish their service areas, hours,
  wait times and fares openly. These give real numbers: which services actually
  cover your trip, how long the wait is, and what it costs.

A few things worth knowing:

- **One provider at a time, by default.** Several ride-hailing providers' API terms
  forbid presenting them in a list beside competitors. An operator can enable
  comparison, and when they do, only providers whose terms permit it join the list.
- **"Estimated" means estimated.** A price with that label was computed from an
  operator's published tariff, not quoted by the service for your trip. A price
  without it came from the provider.
- **Quotes go stale.** They expire in about a minute. The panel counts down and
  fetches a fresh price the moment one lapses, but only while you are actually
  looking at it — switch tabs or leave it alone for a few minutes and it stops,
  rather than pricing a trip nobody is watching. A Refresh link brings it back.
- **Your trip leaves the server, not your browser.** For open feeds, your pickup and
  destination are sent by your OpenMapX server to the feed, and the answer is never
  cached or stored. For the app handoffs nothing is sent at all until you click.

## Configuration

You rarely need to touch routing internals — enabling an engine service is
usually all it takes. Routing engines are backend **services**; enable and run
them with the `openmapx` CLI:

```bash
pnpm openmapx services enable valhalla        # planet-capable, all ground modes
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

For engine-specific build and tuning details (elevation and admin-boundary
toggles, region builds, memory needs), see the
[Self-hosting routing engines](../guides/routing-engines.md) guide.

## Related features

- **[Search](./search.md)** — find the places you route between.
- **[Public transit](./public-transit.md)** — journey planning by bus, train,
  and tram.
- **[Map layers](./map-layers.md)** — traffic, satellite, and other overlays you
  can switch on while planning a route.
- **[Crowd reports](./crowd-reports.md)** — report or verify live conditions.
