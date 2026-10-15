---
title: Mobility & live data
description: Live points of interest on the map — EV chargers, fuel prices, parking, shared bikes and scooters, car-sharing, traffic webcams, message signs, road weather, road maintenance vehicles and border wait times, drawn from open mobility data.
sidebar_position: 9
---

# Mobility & live data

Beyond the base map and its [overlays](./map-layers.md), OpenMapX can plot
real-world points of interest with live detail attached. Pick **EV charging**
and the map fills with charging stations, each colored by whether it's available
or in use, with connector types and power on click. Pick **Gas Stations** and
you get live fuel prices per grade. There's also parking with live occupancy from OpenConditions,
shared bikes and e-scooters and car-sharing vehicles you can actually rent right
now, traffic and scenic webcams, the message signs along the roads with what
they show, road weather stations, the snowploughs and other maintenance
vehicles at work, and how long the queues at border crossings are.

These are different from map overlays. An overlay paints a theme across the whole
map; a mobility data source answers a question about the area you're looking at
("what chargers are near here?") and returns individual, clickable points with
their own details, freshness, and source credits.

## What you get

Each data source is a category you can switch on, and each plots its own kind of
point with category-appropriate detail in the place panel:

- **EV charging** — charging stations colored by operational status, with
  connector types, power ratings, tariffs, and live charge-point status where a
  feed publishes it.
- **Fuel** — gas stations with live prices per fuel grade (diesel, E5, E10, and
  national equivalents) where a pricing feed covers the area.
- **Parking** — parking facilities and Park & Ride lots, with live free-space
  counts where the upstream feed reports them.
- **Bike sharing** — docking stations and free-floating bikes, with the number
  of bikes and free docks currently available.
- **Car sharing** — car-sharing stations and vehicles, with availability and
  pricing where published.
- **E-scooters** — free-floating scooters and any operator no-ride, no-parking,
  or slow zones drawn as shaded areas on the map.
- **Webcams** — traffic and scenic cameras. A camera with several views shows
  each view's still, refreshed while the panel is open; streams and players
  load in the panel after you allow external media. A camera whose views are
  all offline or no longer updated is drawn dimmed.
- **Message signs** — dynamic message signs beside the roads. A sign showing a
  message is drawn in amber, and its panel lists each page line by line with
  the time it went up; a blank or failed sign is drawn dimmed and says so.
- **Road weather** — road weather stations, colored by the most hazardous
  surface any of their sensors measures: green for dry, blue for wet, purple
  for snow or slush, red for ice or frost. The list sums up each station's
  surface, coldest road temperature and air temperature and sorts by road
  temperature; the panel shows each surface sensor (state, road and ground
  temperature, freezing point, grip, water, snow, ice, salt) and the weather
  above the road, with the time they were measured. A station out of service
  or offline, or without a value from the last hour, is drawn dimmed and says
  so. A station whose operator suspects or has confirmed a fault keeps its
  values, with the fault noted in the list and atop the panel.
- **Road maintenance** — snowploughs, spreaders and other road maintenance
  vehicles where they last reported, each trailing a faint line of where it
  has been in its current task over the last ten minutes: blue while
  ploughing, orange while salting or sanding, green for other work. The panel
  names what the vehicle is doing, lists the tasks it reports, whether its
  plough is down or its spreader on, and its heading. Positions are anonymous
  and vanish ten minutes after a vehicle last reports; an open panel follows
  the vehicle to its next position.
- **Border crossings** — land border crossings, colored by the longest current
  wait for cars: green up to 15 minutes, orange up to 45, red beyond, grey when
  closed. Where both countries publish their queues, the crossing shows both
  directions; the panel lists each direction's queues (cars, trucks,
  pedestrians and their trusted-traveller or Ready lanes) with the wait, the
  lanes open and the time it was stated, and the list sorts by wait.

Selecting a category queries the visible map, drops markers, and — because these
feeds are area-based — shows a **Search this area** chip when you pan or zoom so
you can refetch for the new viewport rather than reloading constantly. Click any
marker to open its [place card](./places.md), which inherits the same enrichment
(photos, knowledge, links) as any other place on the map.

## How it works

All of these features are built on one generic mechanism: the **data-source
system**. It's a single integration (`data-source`) that defines a common
contract, and every category above is a small integration that implements that
contract for its domain. That shared design is why a charging station, a parking
garage, and a shared scooter all behave consistently on the map despite coming
from completely different upstreams.

A data-source integration answers four kinds of question for a given map
viewport:

- **Search** — given a bounding box (and any active filters), return the points
  to plot.
- **Detail** — given one point, return the rich content for the place panel.
- **Filters** — describe the filter controls to offer (connector type, fuel
  grade, operator, available-only, and so on).
- **Map context** — optional shaded zones that belong with the points, such as a
  scooter operator's no-parking areas.

Two properties of the contract matter for everyone running OpenMapX:

**Multi-source merge.** A single category usually draws on _several_ upstream
feeds at once. The integration queries every feed that covers the visible area
in parallel and merges the results into one set of points, so you don't pick a
provider — you get whichever sources have coverage where you're looking. Fuel
prices in Germany come from Tankerkönig; pan to France and the French national
feed takes over; everywhere else, OpenStreetMap supplies locations without
prices. The same point can even be assembled from more than one feed.

**Attribution and freshness travel with the data.** Every response carries the
credits for exactly the sources that contributed to _this_ view and a freshness
stamp (when it was fetched, whether it's realtime, whether it's gone stale).
Browsing fuel in one German city credits only Tankerkönig, not the whole
European stack of feeds. The credits appear in the map's attribution strip while
the layer is on and disappear when you switch it off — license-required
attribution is handled for you, automatically and per-view.

Responses are cached server-side so a popular viewport isn't re-fetched from the
upstream on every pan, and — like every other external call in OpenMapX —
requests are proxied through your server, so upstream providers see your
server's address rather than your users'.

### Where the data lives

The sharing categories are queried live from the upstream API for the bounding
box you're looking at. EV charging, parking, fuel, webcams, message signs, road
weather, road maintenance and border crossings come from
[OpenConditions](../administration/community-extensions.md#example-openconditions),
which fetches, parses, and links the national registers on its own schedule;
OpenMapX reads only the sites that intersect your viewport. From the map this
is invisible; the practical difference is operational, covered under
[enabling and configuring](#enabling-and-configuring) below.

## The built-in sources

OpenMapX ships eleven data-source categories. The table groups them by what they
show; the _Origins_ column is a representative sample, not the full list — most
categories aggregate many regional feeds, and OpenStreetMap is the global
fallback for the location-only sources.

| Category             | What it shows                                 | Origins (representative)                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EV charging**      | Charging stations, status, connectors         | Every enabled charging-site provider: OpenConditions' charging feeds (Bundesnetzagentur and MobiData BW (DE), AFDC (US), France IRVE, NOBIL (NO), Digitraffic (FI), NDW (NL), SFOE (CH), and national registers across Europe, Asia, and Australia; with the operator token also Open Charge Map, OpenStreetMap and Slovenia's register) |
| **Fuel**             | Gas stations + per-grade prices               | Every enabled fuel-station provider: OpenConditions' national price feeds (Prix Carburants, Minetur; with the operator token also Tankerkönig/MTS-K and E-Control) and OpenStreetMap (operator token only)                                                                                                                               |
| **Parking**          | Parking + Park & Ride, live occupancy         | Every enabled parking provider: OpenConditions' parking feeds (MobiData BW, NRW.Mobidrom, DB BahnPark, SBB, RDW and NDW truck parking (NL), HDB (SG), and many city and regional open-data portals; with the operator token also the Mobidrom Park & Ride lots, the French BNLS and OpenStreetMap)                                       |
| **Bike sharing**     | Docks + free-floating bikes, availability     | GBFS feeds via the MobilityData catalog, CityBikes, Nextbike, Donkey Republic, Deutsche Bahn, Entur (NO)                                                                                                                                                                                                                                 |
| **Car sharing**      | Car-sharing stations + vehicles               | GBFS catalog, Entur, Cambio, Communauto, CoopStroom, Dégage, and German municipal portals                                                                                                                                                                                                                                                |
| **E-scooters**       | Free-floating scooters + operator zones       | GBFS catalog, Entur (NO), NRW.Mobidrom (Voi, Lime), Felyx                                                                                                                                                                                                                                                                                |
| **Webcams**          | Traffic + scenic cameras, still or live video | Every enabled camera provider: OpenConditions' camera feeds (Digitraffic (FI), Trafikverket (SE), Statens vegvesen (NO), Vegagerðin (IS), DGT (ES), Ontario 511, Hong Kong TD, Transport for NSW, TDX (TW), TfL, Caltrans, NPS, Oregon TripCheck; with the operator token also Windy, OpenStreetMap, 511NY and five US 511 states)       |
| **Message signs**    | Dynamic message signs + what they show        | Every enabled message-sign provider: OpenConditions' sign feeds (511NY, with the operator token)                                                                                                                                                                                                                                         |
| **Road weather**     | Road weather stations, surface + air values   | Every enabled road-weather provider: OpenConditions' road weather feeds (Fintraffic Digitraffic (FI))                                                                                                                                                                                                                                    |
| **Road maintenance** | Maintenance vehicles + the work they do       | Every enabled service-vehicle provider: OpenConditions' vehicle feeds (Fintraffic Digitraffic maintenance tracking (FI), from the Harja system)                                                                                                                                                                                          |
| **Border crossings** | Land border crossings + wait times each way   | Every enabled border-crossing provider: OpenConditions' border feeds (U.S. Customs and Border Protection, Canada Border Services Agency)                                                                                                                                                                                                 |

A few notes on origins:

- **Sharing categories** lean heavily on **GBFS** (the General Bikeshare Feed
  Specification), the open standard most micro-mobility operators publish. The
  MobilityData GBFS catalog lets a single integration discover and read hundreds
  of operator feeds worldwide, which is why bike, car, and scooter sharing reach
  far beyond the named operators above.
- **OpenStreetMap** (queried via the Overpass service) backs the location-only
  sources everywhere a richer feed doesn't reach — chargers, fuel stations,
  car parks and webcams all fall back to it. OpenStreetMap's car parks, fuel
  stations and webcams come through OpenConditions (`osm-parking`, `osm-fuel`,
  `osm-cameras`) and only with the operator token.
- **Licenses vary by source**, from public-domain and CC BY open data to
  bilateral commercial terms; each source declares its own license and
  attribution in its manifest, which is what feeds the per-view credits and the
  generated `/privacy` and `/terms` pages.

## Enabling and configuring

Each category is its own [integration](../overview/how-it-works.md), and the
generic `data-source` integration it depends on must be enabled too. A category
appears in the search chips only when its integration is enabled — disabling
`fuel`, for example, removes the **Gas Stations** chip entirely. Manage these
from the admin panel's integration list.

Many sources work out of the box from open feeds and need no setup. Others
require credentials, declared per integration:

- **EV charging** comes from [OpenConditions](../administration/community-extensions.md#example-openconditions);
  without it the charging source is not offered and has no chip. Credentials
  for the keyed feeds (AFDC, NOBIL, Open Charge Map, and the Korean, Singapore,
  Slovenian and Taiwanese registers) are OpenConditions ingest feed
  credentials: set them in the admin panel as service credentials of
  `openconditions-ingest`. Open Charge Map (redistribution not granted),
  OpenStreetMap (ODbL share-alike) and Slovenia's register (CC BY-SA) are
  restricted sources and reach OpenMapX only with the
  [operator token](../administration/community-extensions.md#the-operator-token)
  set on both sides.
- **Fuel** comes from [OpenConditions](../administration/community-extensions.md#example-openconditions);
  without it the fuel source is not offered and has no chip. Credentials for
  keyed price feeds (such as Tankerkönig for Germany) are configured in
  OpenConditions. Germany (Tankerkönig: redistribution not granted), Austria
  (E-Control: no licence asserted) and every station known only from
  OpenStreetMap (ODbL share-alike) also need the
  [operator token](../administration/community-extensions.md#the-operator-token)
  set on both sides; without it the fuel layer shows France and Spain only.
- **Parking** comes from [OpenConditions](../administration/community-extensions.md#example-openconditions);
  without it the parking source is not offered and has no chip. Credentials for
  the keyed feeds (DB BahnPark, North East UTMC, Transport for NSW) are
  OpenConditions ingest feed credentials: set them in the admin panel as service
  credentials of `openconditions-ingest`. The Mobidrom Park & Ride lots
  (CC BY-SA), the French BNLS (ODbL) and every facility known only from
  OpenStreetMap are restricted sources and reach OpenMapX only with the
  [operator token](../administration/community-extensions.md#the-operator-token)
  set on both sides.
- **Webcams** come from [OpenConditions](../administration/community-extensions.md#example-openconditions);
  without it the webcam source is not offered and has no chip. Credentials for
  the keyed feeds (Trafikverket, Ontario 511, Transport for NSW, TDX, NPS,
  Oregon TripCheck, Windy and the US 511 states) are OpenConditions ingest feed
  credentials: set them in the admin panel as service credentials of
  `openconditions-ingest`. Windy (redistribution not granted), OpenStreetMap
  (ODbL share-alike) and the Georgia, Arizona, Idaho, Utah and Louisiana 511
  systems (no data licence) are restricted sources and reach OpenMapX only with
  the [operator token](../administration/community-extensions.md#the-operator-token)
  set on both sides. Stills are shown only from image hosts a live camera
  source declares.
- **Message signs** come from [OpenConditions](../administration/community-extensions.md#example-openconditions);
  without it the message-sign source is not offered and has no chip. 511NY's
  signs are granted under NYSDOT's Developer Access Agreement, a restricted
  source that reaches OpenMapX only with the
  [operator token](../administration/community-extensions.md#the-operator-token)
  set on both sides.
- **Road weather**, **road maintenance** and **border crossings** come from
  [OpenConditions](../administration/community-extensions.md#example-openconditions);
  without it these sources are not offered and have no chip. Their feeds are
  open data (Digitraffic under CC BY 4.0, CBSA under the Open Government
  Licence – Canada, CBP in the U.S. public domain) and need neither keys nor the
  operator token. Temperatures, wind and visibility are shown in metric units.

Charging coverage also includes open registries for Belgium, Cyprus, Spain,
Luxembourg, Lithuania, Hong Kong, New Zealand, and several
Australian states. OpenConditions' feed catalogue is the authoritative
per-source license and configuration inventory.

Where a source has no key, it's simply skipped and the others still answer. Keys
set on an integration follow the usual config cascade — admin panel or `.env`.

Some sources also lean on backend services: the OpenStreetMap fallback needs the
**Overpass** service, and the sharing categories use the transit engine and geocoder for station naming. A source whose
required backend isn't running simply stays quiet rather than erroring. See
[Managing services](../install/managing-services.md) for enabling those backends.

## Related features

- [Map layers & overlays](./map-layers.md) — the whole-map themes these
  point sources complement (including a live-transit-positions overlay).
- [Places](./places.md) — the place card that opens when you click a data-source
  marker, with photos, knowledge, and reviews.
- [Search](./search.md) — the search bar and category chips these sources appear
  in.
- [Directions](./directions.md) and [public transit](./public-transit.md) —
  routing to a charger, parking lot, or station you found here.
