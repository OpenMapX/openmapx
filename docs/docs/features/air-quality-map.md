---
title: Air-quality monitor map
description: Raw pollutant concentrations, monitor quality, freshness, and provenance on the OpenMapX map.
sidebar_position: 13
---

# Air-quality monitor map

The **Air quality** map layer shows measurements from ground-monitoring stations.
It is a concentration map, not an air-quality index (AQI) map. Its colors do not
mean “good”, “moderate”, or another health category, and values from different
pollutants should not be compared as if they shared one scale.

The layer starts with PM2.5 and supports PM10, ozone (O3), nitrogen dioxide
(NO2), sulfur dioxide (SO2), carbon monoxide (CO), ammonia (NH3), and nitric
oxide (NO). The legend prints the selected pollutant's raw unit and the numeric
stops `0`, `10`, `25`, `50`, `75`, and `100+`. A value above 100 remains
unclamped in the station popup; only symbol size and the end of the color scale
are capped.

The shared map scale is µg/m³. Mass concentrations reported in mg/m³ are
converted losslessly; ppb/ppm records are excluded because converting a volume
mixing ratio to mass concentration requires physical assumptions the source did
not provide.

## Reading stations

Select a station to see its raw value and unit, observation and measurement
interval, freshness, quality status, station class, fixed/mobile status,
completeness, and estimated or gap-filled flags. The popup also names the
provider, contributing source IDs, and data owner. Freshness changes marker
opacity and station class changes its outline, but those states are always
written as text as well as encoded visually.

Source credits in the map attribution are derived from the stations in the
current completed snapshot. They are deduplicated and disappear immediately
when the layer is hidden or leaves monitor mode.

:::caution[Raw values are not health guidance]
The continuous colors make spatial differences easier to see; they are not
regional AQI categories or regulatory advice. Use the [place air-quality
result](./air-quality.md) for the locally applicable reviewed index and its
method-specific category when enough evidence exists.
:::

## Loading and degraded results

Station loading starts at zoom 5. After the map stops moving, OpenMapX requests
the visible WGS84 bounding box, integer zoom, and selected pollutant from the
canonical station API. It reads immutable pages of at most 500 features and
publishes the completed snapshot once, up to a 2,000-marker client cap.

The legend reports loading, empty viewports, stale evidence, policy exclusions,
provider failures, quota/size truncation, and unavailable upstreams separately.
If a refresh fails after a snapshot was displayed, the prior markers and their
source credits stay visible and the legend identifies them as retained data.
Changing pollutant clears the old-pollutant markers immediately while the new
snapshot loads.

An expired immutable cursor is restarted once from the first page. Moving again,
hiding the layer, changing mode, or unmounting it aborts obsolete work; an older
response cannot replace a newer viewport. A basemap or theme style replacement
recreates the layer with the retained completed snapshot.

The public overlay identity remains `air-quality`, including deep links such as
`ov=air-quality`. Frontend ownership belongs only to the canonical
`air-quality` integration. The older `overlay-air-quality` integration remains
a backend OpenAQ provider and its legacy station route is not used by the
first-party map.
