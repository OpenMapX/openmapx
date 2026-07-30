---
title: Map layers & overlays
description: Switch the base map style and toggle thematic overlays — traffic, weather, hazards, recreation, and more — each contributed by an integration.
sidebar_position: 5
---

# Map layers & overlays

The map you see is built in two parts: a **base style** that draws the world
underneath, and a stack of optional **overlays** layered on top. The base style
sets the overall look — a clean street map, satellite imagery, shaded terrain.
Overlays add a single theme over whatever base you've chosen: live traffic, a
weather radar loop, hiking trails, recent earthquakes, and so on.

You control both from the **layer picker** in the bottom-left corner of the map.

## Base map styles

A base style is the foundation, and exactly one is active at a time. OpenMapX
ships four:

| Style          | What it shows                                                              |
| -------------- | ------------------------------------------------------------------------- |
| **Default**    | The standard OpenMapX street map — roads, labels, land use, water.        |
| **Satellite**  | True-color aerial and satellite imagery instead of drawn streets.         |
| **Terrain**    | A relief-shaded map that emphasizes elevation, slopes, and landforms.     |
| **Cycling**    | A bike-oriented base that foregrounds cycle routes and infrastructure.    |

Where the imagery comes from depends on how your instance is configured. The
street and terrain bases are served by your tile stack (a self-hosted tile
server, or MapTiler Cloud); satellite imagery requires a configured imagery
source. If a base style has no data source available on your deployment, it
simply isn't offered. The picker also has a **Globe view** toggle that switches
the map from a flat projection to a 3D globe.

## How overlays work

Every overlay is an [integration](../overview/how-it-works.md). A map-overlay
integration declares a few things in its manifest:

- a **map-layer component** that draws onto the MapLibre map,
- an optional **legend** explaining its colors or symbols,
- its **data source** and the **attribution** that must appear while it's on,
- and where it belongs in the picker (the *Map details* group, or the *Map
  tools* group).

The web app discovers these at runtime and builds the picker from whatever
overlay integrations are enabled — so the list below describes the full catalog,
not a fixed menu. Toggle an overlay on and its layer is added to the map and its
attribution joins the credits in the corner; toggle it off and both go away.
Several overlays can be on at once. A few declare **exclusions** (for example,
the weather and air-quality overlays don't stack on top of each other), so
turning one on automatically turns its conflicting siblings off.

Because overlays come from integrations, the catalog is yours to shape. Enabling
or disabling an integration adds or removes its entry from the picker; community
integrations can contribute new overlays of their own. Some overlays also have
prerequisites — the cycling and hiking layers query OpenStreetMap through the
Overpass service, the travel-time tool wants a Valhalla routing engine — and an
overlay whose required service isn't running is hidden until it is. See
[Managing services](../install/managing-services.md) for enabling those
backends, and [How it works](../overview/how-it-works.md) for the
service-and-integration model.

## The overlay catalog

The built-in overlays group into a few themes.

### Transportation

| Overlay                | Shows                                                | Data                          |
| ---------------------- | ---------------------------------------------------- | ----------------------------- |
| **Traffic**            | Live traffic-flow coloring on roads                  | TomTom Traffic (needs an API key) |
| **Traffic flow**       | Congestion coloring from your own road-conditions feeds | [OpenConditions](../developer/building-an-external-extension.md) speed data |
| **Transit lines**      | Public-transport routes and lines                    | OpenStreetMap                 |
| **Live transit**       | Real-time bus, tram, and train positions             | Live-vehicle feeds (e.g. DB RIS, Entur) |
| **Airports**           | Airport locations and metadata                       | OurAirports                   |
| **Road conditions**    | Incidents, roadworks, and closures (community extension) | [OpenConditions](../developer/building-an-external-extension.md) |

The traffic overlay needs a TomTom API key (set in the admin panel or via
`.env`), and only renders above a minimum zoom. The **Traffic flow** overlay is
the self-hosted alternative: it colors roads by congestion — a green→dark-red
gradient (free-flow, light, moderate, heavy, severe) computed from the ratio of
current to free-flow speed in your own [OpenConditions](../developer/building-an-external-extension.md)
road-conditions feeds (NDW, Fintraffic, Trafikverket, NYC DOT, and others),
with line opacity marking whether each reading is measured, estimated, or typical.
It needs no API key, and because it and the TomTom **Traffic** overlay both color
flow, turning one on turns the other off. The live-transit overlay picks
one vehicle-position provider per visible region. The **Road conditions** overlay
plots traffic incidents, roadworks, hazards, and closures. It features an
interactive, filterable legend allowing users to filter by incident
type (roadworks, closures, lane closures, accidents, congestion, detours, hazards,
obstructions) and minimum severity (low, medium, high, critical). Clicking an
incident displays a localized popup showing affected roads, descriptions, and
structured validity times (including recurring schedule windows in the source's
local timezone). Overlapping markers are automatically grouped into a single scrollable
popup (ordered most-severe first) so all incidents at the same spot stay reachable, and
linear events (such as segment closures) render as line segments directly on the map.
Where a feed provides measured speed, an incident popup also estimates the delay
in minutes; otherwise it preserves the source's declared level of service rather
than inventing a speed.
These overlays complement the dedicated [public transit](./public-transit.md) and
[directions](./directions.md) features rather than replacing them.

### Context-aware layers

Useful layers follow the task without becoming permanent preferences. Opening a
driving or motorcycle route enables **Road conditions** and **Traffic flow**;
planning or navigating a transit trip enables **Transit lines** and **Live
transit**. Only layers available on the deployment are touched. A layer that was
already on stays on afterward, a manual toggle made during the trip is respected,
and layers enabled only by the context switch back off when it ends.

### Environment & weather

| Overlay              | Shows                                                  | Data                                  |
| -------------------- | ----------------------------------------------------- | ------------------------------------- |
| **Weather**          | Precipitation radar animation, plus temperature/cloud/wind/pressure tiles | RainViewer, OpenWeather, Open-Meteo |
| **Weather alerts**   | Active severe-weather warnings                        | NOAA, Environment Canada, DWD, MeteoAlarm |
| **Air quality**      | Air-quality index from monitoring stations            | OpenAQ                                |
| **Environment**      | Readings from community environmental sensors         | openSenseMap, Sensor.Community        |

The weather overlay's radar loop works out of the box; its temperature, cloud,
wind, and pressure tiles need an OpenWeather API key. The weather overlay here is
the map-wide layer — the per-place forecast lives in the [weather](./weather.md)
feature.

### Hazards & natural events

| Overlay              | Shows                                                  | Data            |
| -------------------- | ----------------------------------------------------- | --------------- |
| **Earthquakes**      | Recent earthquakes, sized by magnitude                | USGS            |
| **Wildfires**        | Active fire hotspots                                   | NASA FIRMS      |
| **Natural events**   | Storms, volcanoes, floods, and other ongoing events   | NASA EONET, GDACS |

These pull from public hazard feeds and are useful for situational awareness at
a glance.

### Recreation & specialty

| Overlay              | Shows                                                  | Data                         |
| -------------------- | ----------------------------------------------------- | ---------------------------- |
| **Cycling**          | Cycle tracks, lanes, parking, and bike shops          | OpenStreetMap (via Overpass) |
| **Hiking**           | Hiking trails and mountain shelters                   | Waymarked Trails, Refuges.info, OpenStreetMap |
| **Winter sports**    | Ski areas, pistes, and lifts                          | OpenSnowMap                  |
| **Nautical**         | Sea marks, depths, tides, and water levels            | OpenSeaMap and marine agencies |
| **Satellite imagery**| A true-color satellite overlay (distinct from the satellite base) | NASA GIBS / MODIS |
| **3D buildings**     | Extruded building footprints from the active vector style | OpenMapTiles-compatible building layers |

### Map tools

Two entries in the picker are interactive tools rather than passive layers:

- **Measure** — draw a path on the map to read off its distance and area.
- **Travel time** — paint an isochrone showing how far you can get within a
  time budget, computed by a Valhalla routing engine.

:::note[Overlays follow your integrations]
The picker only lists overlays whose integration is enabled and whose required
services are running. If an overlay you expect is missing, check that its
integration is enabled and any backend it needs (Overpass, Valhalla, a transit
provider) is part of your service selection.
:::

## Related features

- [Search](./search.md) and [places](./places.md) — finding and inspecting
  points on the map.
- [Directions](./directions.md) and [public transit](./public-transit.md) —
  routing, which uses some of the same backends as the transit overlays.
- [Street-level imagery](./street-level-imagery.md) — the immersive ground-level
  view, which can't be on at the same time as some overlays.
- [Crowd reports](./crowd-reports.md) — submit and verify conditions shown by
  the road-conditions overlay.
- [Weather](./weather.md) and [mobility data](./mobility-data.md) — related
  data-driven features.
