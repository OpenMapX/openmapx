---
title: Map layers & overlays
description: Choose a base map and add traffic, weather, transit, hazards, and other map information.
sidebar_position: 5
---

# Map layers & overlays

Open **Layers** in the lower-left map controls to choose a base map or add
information such as traffic, weather, or transit. On smaller screens, open the
layer panel for the full selection. The available entries depend on enabled
integrations.

Choose one base style at a time. Several overlays can be active together, except
where their displays conflict. Use a layer's legend to read its scale, filters,
and loading or unavailable status.

## Base map styles

A base style is the foundation, and exactly one is active at a time. OpenMapX
ships four:

| Style         | What it shows                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| **Default**   | Roads, labels, land use, water, and soft mountain shading.                                            |
| **Satellite** | True-color aerial and satellite imagery, with street and place labels drawn on top.                   |
| **Terrain**   | The street map with shaded relief, elevation tinting, contour lines, and 3D terrain when you tilt it. |
| **Cycling**   | A bike-oriented base that foregrounds cycle routes and infrastructure.                                |

Where the data comes from depends on how your instance is configured. The street
map is served by your tile stack (a self-hosted tile server, OpenFreeMap, or MapTiler Cloud).
Default and Terrain add elevation data on top of it: Mapterhorn when you host
your own tiles or OpenFreeMap, MapTiler Terrain with a MapTiler basemap, or a DEM of your own
(see [Map tiles](../guides/map-tiles.md)). Default only shades mountains softly
between zoom 6 and 14; Terrain shows the full relief at every zoom. Satellite imagery comes from MapTiler and
needs `MAPTILER_KEY`; the cycling base uses Thunderforest when a key is set and
CyclOSM otherwise. The picker always lists all four bases, so a base whose
source isn't configured on your deployment shows no imagery. While an offline
package is active, Default and Terrain show the flat street map. The picker also has a
**Globe view** toggle that switches the map from a flat projection to a 3D globe.

## Places while browsing

The owned street map introduces a small selection of named restaurants, cafés,
bars, bakeries and shops at neighborhood zooms 14 to 15. These labels yield space
to existing destinations, transit and road names; they do not show every business.
The ordinary close-up POI layers take over from zoom 16. Parking and small
street fixtures keep their later introduction.

Visibility depends on the local rank and coverage of the active OpenMapTiles
dataset, followed by label collisions. Rank is not a rating or popularity score.
Tap a visible business symbol to open its place sheet; category search can find
additional destinations that are not labeled on the map. See the
[comparison baseline](../developer/map-comparison-baseline.md) for fixed German
examples and how to assess cartography changes.

When an operator publishes a regional place snapshot, the map automatically adds
ranked named OSM and Overture destinations during ordinary browsing, without a
category search or a switch in Layers. Essential destinations start at zoom 13; everyday businesses
appear later, and indoor/non-ground tenants wait until zoom 18. Label collisions
still limit what is visible. These ranks express usefulness and source importance,
not ratings, popularity, or a promise that a business is currently open.

These places are ordinary map content, not an overlay you turn on: there is no
Layers entry, legend or loading message, and links that still carry the old
`ov=ambient-places` token keep working but no longer write it. The map avoids
repeating a confidently matched owned-basemap label or an already
selected/category-result marker. Tapping a matched label opens the same
canonical place identity as search, and the credits strip names the sources of
the labels actually drawn. Outside the published region, before publication, or
when the operator disables the snapshot or it is older than 90 days, normal map
browsing continues with the basemap alone. An operator can still turn the
integration off in administration. See [Overture Places](./overture-places.md)
for source policies and operator setup.

## How overlays work

Overlay integrations contribute entries to the layer picker. Enabling a layer
adds its map content and applicable source credits; disabling it removes them.
Some pairs exclude each other: weather and air quality, schematic and ordinary
transit lines, or the two traffic-flow displays.

An enabled entry does not prove its data source is configured or responding.
Some unavailable layers remain listed and explain the problem in their legend.
Others require a closer zoom before loading. Operators can check integration
enablement, credentials, source policy, and backend services under
[Admin → Integrations](../administration/integrations-administration.md).

## The overlay catalog

The built-in overlays group into a few themes.

### Transportation

| Overlay                   | Shows                                                                                                | Data                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Traffic**               | Live traffic-flow coloring on roads                                                                  | TomTom Traffic (needs an API key)                                                             |
| **Traffic flow**          | Congestion coloring from your own road-conditions feeds                                              | [OpenConditions](../administration/community-extensions.md#example-openconditions) speed data |
| **Transit lines**         | Public-transport routes and lines                                                                    | OpenStreetMap                                                                                 |
| **Schematic transit map** | Metro-map style network plans with layout and network-group choice (mutually excludes Transit lines) | [LOOM](./schematic-transit-map.md) (University of Freiburg), OpenStreetMap-derived            |
| **Live transit**          | Real-time bus, tram, and train positions                                                             | Live-vehicle feeds (e.g. DB RIS, Entur)                                                       |
| **Airports**              | Airport locations and metadata                                                                       | OurAirports                                                                                   |
| **Road conditions**       | Incidents, roadworks, and closures                                                                   | [OpenConditions](../administration/community-extensions.md#example-openconditions)            |

The traffic overlay needs a TomTom API key (set in the admin panel or via
`.env`), and only renders above a minimum zoom. The **Traffic flow** overlay is
the self-hosted alternative: it colors roads by congestion using a green-to-dark-red
gradient (free-flow, light, moderate, heavy, severe) computed from the ratio of
current to free-flow speed in your own [OpenConditions](../administration/community-extensions.md#example-openconditions)
road-conditions feeds (NDW, Fintraffic, Trafikverket, NYC DOT, and others),
with line opacity marking whether each reading is measured, estimated, or typical.
It needs no API key, and because it and the TomTom **Traffic** overlay both color
flow, turning one on turns the other off. Its tiles come from OpenConditions
through the Martin tile server; without either, or while its tiles fail to
load, **Traffic flow** stays in the layer list and its legend says the data is
unavailable. The live-transit overlay picks
one vehicle-position provider per visible region. The **Road conditions** overlay
plots traffic incidents, roadworks, hazards, and closures. It features an
interactive, filterable legend allowing users to filter by incident
type (roadworks, closures, lane closures, accidents, congestion, detours, hazards,
obstructions) and minimum severity (low, medium, high, critical). Clicking an
incident displays a localized card: what it is and the road and direction it
affects, how much it affects traffic, until when it holds (or when it starts,
including recurring schedule windows in the source's local timezone), what it
does to traffic (closed roads and lanes, vehicle limits, delays, detours), the
source's own description (a long one shows its first lines and opens in place with
"Show more"), and one credit line per source with when it was last
updated. Overlapping markers are automatically grouped into a single scrollable
popup (ordered most-severe first) so all incidents at the same spot stay reachable, and
linear events (such as segment closures) render as line segments directly on the map.
Where a feed provides measured speed, an incident popup also estimates the delay
in minutes; otherwise it preserves the source's declared level of service rather
than inventing a speed.
The legend's **Show on map** list switches the overlay's layers: the incidents
(on by default) and, where the server has a source for them, **Message signs**,
**Road weather**, **Road maintenance** vehicles and **Border crossings**, which
start off. A switched-on layer shows its color key, or says when nothing is in
the area; its markers carry the layer's own glyph and open in the place panel.
The incident filters show only while the incidents are on. These layers are the
same [mobility data sources](./mobility-data.md) the search finds, drawn for the
area in view and refreshed as the map moves. The browser remembers which layers
are on and how incidents are filtered, so they come back on the next visit.
Without a road-conditions source, such as an OpenConditions instance at
`OPENCONDITIONS_URL`, **Road conditions** stays in the layer list and its legend
says traffic incidents are unavailable instead of showing a clear road.
Navigation then reports live incidents as not current.
These overlays complement the dedicated [public transit](./public-transit.md) and
[directions](./directions.md) features rather than replacing them.

The **Traffic flow** legend uses a compact **Fast/Slow** color scale. Open
**About traffic** with the info button in either traffic legend for its source
and limitations. The owned legend also explains measured, estimated and typical
readings there, using the same opacity as the renderer. A hidden layer stays
explicitly labelled hidden.

The tile formats expose no usable upstream/publication time or completeness
metadata, so the details say the update time is unknown and some roads may be
missing. Downloading a tile does not establish fresh measurements. Road colors
do not establish whether traffic delays are included in a route's travel time.

**Map colors do not verify traffic influence on a route.** The routing engine can
differ from the displayed overlay: hosted TomTom traffic over a self-hosted
Valhalla route is still a map visualization. Directions cards show estimated
traffic delays when comparison data is available and explain road-update
verification separately; see
[Reading traffic information](./directions.md#reading-traffic-information).

### Context-aware layers

Useful layers follow the task without becoming permanent preferences. Opening a
driving or motorcycle route enables **Road conditions** and **Traffic flow**;
planning or navigating a transit trip enables **Transit lines** and **Live
transit**. Only layers available on the deployment are touched. A layer that was
already on stays on afterward, a manual toggle made during the trip is respected,
and layers enabled only by the context switch back off when it ends.

### Environment & weather

| Overlay            | Shows                                                                                   | Data                                                                |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Weather**        | Precipitation radar animation, plus temperature/precipitation/cloud/wind/pressure tiles | RainViewer, OpenWeather                                             |
| **Weather alerts** | Active severe-weather warnings                                                          | NWS, Environment Canada, DWD, MeteoAlarm, through OpenConditions    |
| **Air quality**    | Raw pollutant concentrations from monitoring stations                                   | Canonical provider orchestration (including OpenAQ when configured) |
| **Environment**    | Readings from community environmental sensors                                           | openSenseMap, Sensor.Community                                      |

The weather overlay's radar loop uses RainViewer without a key (returning
HTTP 451 if RainViewer is excluded by policy); its temperature, precipitation, cloud,
wind, and pressure tiles require an OpenWeather API key (`INTEGRATION_OVERLAY_WEATHER_OWMAPIKEY`).
If an OpenWeather sublayer is selected while unconfigured or unavailable, the UI
automatically falls back to the RainViewer radar loop. The weather overlay here is
the map-wide layer. The per-place forecast lives in the [weather](./weather.md)
feature.

The air-quality overlay uses a continuous numeric concentration scale rather
than AQI health categories. See the [air-quality monitor map](./air-quality-map.md)
for its pollutant, provenance, and degraded-data semantics.

### Daylight & time zones

| Overlay                   | Shows                                                                                                                                | Data                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Daylight & time zones** | Day/night terminator with civil, nautical, and astronomical twilight shading, plus time zone boundaries and their current UTC offset | Terminator computed locally; boundaries from timezone-boundary-builder (OpenStreetMap) |

The terminator is computed locally from the sun's position for the selected
date and time; it credits no external source. Time zone boundaries are a
separate sub-toggle: polygons derived from OpenStreetMap under the ODbL,
tinted and labeled with their current UTC offset, rendered up to zoom 8 (past
that, city scale, the boundaries get noisy and the fill loses its point).

Boundary data is bundled with the integration rather than fetched for each view.
It describes mapped time zones; use the displayed date and offset when comparing
places.

### Hazards & natural events

| Overlay            | Shows                                                                   | Data                                        |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------- |
| **Earthquakes**    | Recent earthquakes, sized by magnitude                                  | USGS                                        |
| **Wildfires**      | Fire hotspots, active fire perimeters, burnt areas and smoke            | NASA FIRMS, EUMETSAT, NIFC, EFFIS, NOAA HMS |
| **Natural events** | Tropical cyclones, volcanoes, floods, droughts and other ongoing events | NASA EONET, GDACS                           |

The earthquake, wildfire, natural-event, and weather-alert layers read through
[OpenConditions](../administration/community-extensions.md#example-openconditions): it fetches the
public hazard feeds, and OpenMapX reads the result from the instance at
`OPENCONDITIONS_URL`. Without it the overlays stay in the layer list and their
legends say the data is unavailable. The weather alert layer, which loads the
whole world at once, credits every feed it loaded; the other layers credit the
feeds of what they drew. Weather alerts are cleared from the map four minutes
after the last successful refresh, so a failed refresh never leaves old
warnings on screen.
Fire hotspots load for the visible area: below zoom 7 they are drawn as a
density grid, from zoom 7 as individual detections. The legend's sensor choice
picks the instrument: VIIRS or MODIS from NASA FIRMS, or Sentinel-3 SLSTR from
EUMETSAT. Detections the instrument rates low confidence (VIIRS and SLSTR low,
MODIS below 30%) are left out of both unless the legend's "Low confidence"
switch is on. MeteoAlarm's European
warnings are drawn with the area shapes MeteoAlarm publishes for redistributors,
and their popup shows the publisher's notice, the issue time and the issuer.
Croatian warnings are drawn with the county outlines of the Croatian State
Geodetic Administration (DGU), whose Open Licence notice joins the map credits
while such a warning is drawn.

### Recreation & specialty

| Overlay               | Shows                                                                                                                                                       | Data                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Cycling**           | Cycle tracks, lanes, parking, and bike shops                                                                                                                | OpenStreetMap (via Overpass)                  |
| **Hiking**            | Hiking trails and mountain shelters                                                                                                                         | Waymarked Trails, Refuges.info, OpenStreetMap |
| **Winter sports**     | Ski areas, pistes, and lifts                                                                                                                                | OpenSnowMap                                   |
| **Nautical**          | Sea marks, depths, tides, and water levels                                                                                                                  | OpenSeaMap and marine agencies                |
| **Satellite imagery** | A true-color satellite overlay (distinct from the satellite base)                                                                                           | NASA GIBS / MODIS                             |
| **3D view**           | Tilts the camera; close-up buildings rise automatically from zoom 16.5 to 17, including when you tilt by gesture, tinted by their mapped colour or material | OpenMapTiles-compatible building layers       |

### Map tools

Two entries in the picker are interactive tools rather than passive layers:

- **Measure**: draw a path on the map to read off its distance and area.
- **Travel time**: paint an isochrone showing how far you can get within a
  time budget. Supports street modes (walking, cycling, driving) computed by
  Valhalla, and public transit reachability computed by MOTIS (rendering a continuous
  estimated surface, with sampled GeoJSON export when explicitly enabled).

:::note[Overlays follow your integrations]
If an entry is missing, check whether its integration is enabled and admitted by
the deployment. If it is listed but empty, check the legend, minimum zoom,
source configuration, coverage, and service health. An empty layer is not proof
that there are no incidents, hazards, or observations.
:::

## Related features

- [Search](./search.md) and [places](./places.md): finding and inspecting
  points on the map.
- [Directions](./directions.md) and [public transit](./public-transit.md):
  routing, which uses some of the same backends as the transit overlays.
- [Street-level imagery](./street-level-imagery.md): the immersive ground-level
  view, which can't be on at the same time as some overlays.
- [Crowd reports](./crowd-reports.md): submit and verify conditions shown by
  the road-conditions overlay.
- [Weather](./weather.md) and [mobility data](./mobility-data.md): related
  data-driven features.
