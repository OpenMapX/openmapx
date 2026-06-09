---
title: Mobility & live data
description: Live points of interest on the map — EV chargers, fuel prices, parking, shared bikes and scooters, car-sharing, and traffic webcams, drawn from open mobility data.
sidebar_position: 7
---

# Mobility & live data

Beyond the base map and its [overlays](./map-layers.md), OpenMapX can plot
real-world points of interest with live detail attached. Pick **EV charging**
and the map fills with charging stations, each colored by whether it's available
or in use, with connector types and power on click. Pick **Gas Stations** and
you get live fuel prices per grade. There's also parking with live occupancy,
shared bikes and e-scooters and car-sharing vehicles you can actually rent right
now, and traffic and scenic webcams.

These are different from map overlays. An overlay paints a theme across the whole
map; a mobility data source answers a question about the area you're looking at
("what chargers are near here?") and returns individual, clickable points with
their own details, freshness, and source credits.

## What you get

Each data source is a category you can switch on, and each plots its own kind of
point with category-appropriate detail in the place panel:

- **EV charging** — charging stations colored by operational status, with
  connector types, power ratings, and operator.
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
- **Webcams** — traffic and scenic cameras, with a still thumbnail and, for
  streams that support it, live video in the panel.

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

**Multi-source merge.** A single category usually draws on *several* upstream
feeds at once. The integration queries every feed that covers the visible area
in parallel and merges the results into one set of points, so you don't pick a
provider — you get whichever sources have coverage where you're looking. Fuel
prices in Germany come from Tankerkönig; pan to France and the French national
feed takes over; everywhere else, OpenStreetMap supplies locations without
prices. The same point can even be assembled from more than one feed.

**Attribution and freshness travel with the data.** Every response carries the
credits for exactly the sources that contributed to *this* view and a freshness
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

Most sources are queried live from the upstream API for the bounding box you're
looking at. A number of the larger or rate-limited feeds — much of the parking
catalog and the bigger national EV registries — are instead **ingested on a
schedule** by the `data-manager` service, which fetches and parses the upstream
feed into a local PostGIS table on a cron; the app then reads only the rows that
intersect your viewport. From the map this is invisible; the practical
difference is operational, covered under [enabling and configuring](#enabling-and-configuring)
below.

## The built-in sources

OpenMapX ships seven data-source categories. The table groups them by what they
show; the *Origins* column is a representative sample, not the full list — most
categories aggregate many regional feeds, and OpenStreetMap is the global
fallback for the location-only sources.

| Category          | What it shows                                  | Origins (representative)                                                                 |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **EV charging**   | Charging stations, status, connectors          | OpenChargeMap (global), AFDC/NREL (US/CA), NOBIL (Nordics), Bundesnetzagentur (DE), France IRVE, SFOE (CH), OpenStreetMap |
| **Fuel**          | Gas stations + live prices                     | Tankerkönig (DE), E-Control (AT), Prix Carburants (FR), Minetur (ES), OpenStreetMap      |
| **Parking**       | Parking + Park & Ride, live occupancy          | ParkAPI / ParkenDD, MobiData BW, DB BahnPark, Autobahn GmbH, plus many city and regional open-data portals, OpenStreetMap |
| **Bike sharing**  | Docks + free-floating bikes, availability      | GBFS feeds via the MobilityData catalog, CityBikes, Nextbike, Donkey Republic, Deutsche Bahn, Entur (NO) |
| **Car sharing**   | Car-sharing stations + vehicles                | GBFS catalog, Entur (NO), Cambio, plus German municipal open-data portals                |
| **E-scooters**    | Free-floating scooters + operator zones        | GBFS catalog, Entur (NO), NRW.Mobidrom (Voi, Lime), Felyx                                |
| **Webcams**       | Traffic + scenic cameras, still or live video  | Windy Webcams, Caltrans, Transport for London, US National Park Service, several US state DOT 511 sites, OpenStreetMap |

A few notes on origins:

- **Sharing categories** lean heavily on **GBFS** (the General Bikeshare Feed
  Specification), the open standard most micro-mobility operators publish. The
  MobilityData GBFS catalog lets a single integration discover and read hundreds
  of operator feeds worldwide, which is why bike, car, and scooter sharing reach
  far beyond the named operators above.
- **OpenStreetMap** (queried via the Overpass service) backs the location-only
  sources everywhere a richer feed doesn't reach — chargers, fuel stations,
  parking, and webcams all fall back to it.
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

- **EV charging** can use API keys for OpenChargeMap, NREL/AFDC (US/CA), and
  NOBIL (Nordics); without them it still works from the open registries and
  OpenStreetMap.
- **Fuel** needs a Tankerkönig key for German live prices; other countries' feeds
  and OpenStreetMap locations need none.
- **Parking** can use credentials for DB BahnPark, Transport for NSW, and the
  Newcastle UTMC feed.
- **Webcams** can use a Windy key plus per-state US DOT 511 keys.

Where a source has no key, it's simply skipped and the others still answer. Keys
set on an integration follow the usual config cascade — admin panel or `.env`.

:::note Credentials for ingested sources live elsewhere
Sources fetched on a schedule by the `data-manager` service (much of parking and
the large EV registries) read their credentials from data-manager environment
variables in `infra/docker/.env`, **not** from the admin panel — the ingest
runs in a container that can't see the per-integration config. The admin fields
for those sources are kept for visibility, but the value the cron uses is the
one in `.env`. See [Managing services](../install/managing-services.md) for the
data-manager and the config cascade, and [Configuration](../install/configuration.md)
for `.env`.
:::

Some sources also lean on backend services: the OpenStreetMap fallback needs the
**Overpass** service, the ingest pipeline needs **PostGIS**, and the sharing
categories use the transit engine and geocoder for station naming. A source whose
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
