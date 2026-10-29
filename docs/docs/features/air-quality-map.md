---
title: Air-quality monitor map
description: Read raw pollutant measurements, station quality, freshness, and source credits.
sidebar_position: 13
---

# Air-quality monitor map

Enable **Air quality** in Layers and zoom to level 5 or closer to see available
ground-monitor measurements. Choose a pollutant in the legend, then select a
station for its value and source details.

:::caution[Concentrations are not health categories]
The colors show raw pollutant concentrations. They do not mean good, moderate,
or another air-quality index category. Different pollutants cannot be compared
as if they shared one health scale. For a regional index where suitable evidence
exists, use [Air quality at a place](./air-quality.md#air-quality-at-a-place).
:::

The layer starts with PM2.5. It also supports PM10, ozone, nitrogen dioxide,
sulfur dioxide, carbon monoxide, ammonia, and nitric oxide. Availability varies
by source and station.

The common scale uses µg/m³, with legend stops at 0, 10, 25, 50, 75, and 100+.
Values above 100 remain visible in station details even though the symbol scale
is capped. Compatible mg/m³ readings are converted to µg/m³. Volume mixing ratios
in ppb or ppm are excluded from this scale because conversion needs additional
physical assumptions.

## Reading stations

Station details show available observation and interval times, freshness,
quality, station class, fixed/mobile status, completeness, estimated or gap-filled
flags, provider, and data owner. Read those labels alongside the value. A
nearby station can describe different conditions from your selected location.

Marker opacity reflects freshness and outlines distinguish station class. Text
labels also state those properties. The map credits sources represented in the
displayed station snapshot.

## Loading and degraded results

The legend distinguishes loading, an empty area, stale evidence, excluded
sources, failures, and truncated results. The client displays at most 2,000
markers, so a dense viewport may omit stations. Zoom in to inspect a smaller area.

A failed refresh can retain the previous markers and credits with a warning.
These are older observations, not proof of current conditions. Changing the
pollutant clears the previous pollutant's markers while the new selection loads.
If no stations appear, check the zoom, pollutant, source coverage, and legend
status before concluding that the area has no pollution.

Operators and client developers can use the
[air-quality monitor API reference](../developer/air-quality-monitor-api.md)
for paging, units, limits, and response states.
