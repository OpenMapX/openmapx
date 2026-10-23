---
title: Air quality
description: Regional air-quality standards, raw pollutant evidence, provenance, forecasts, and station coverage in OpenMapX.
sidebar_position: 12
---

# Air quality

OpenMapX shows air-quality observations and forecasts with their source,
freshness, and calculation method. It selects a location's regional index when
enough suitable evidence is available. You can request another supported
standard for comparison without replacing that local headline.

Supported methods include US EPA 2024 AQI, European AQI, UK DAQI, India NAQI,
China's HJ 633-2026, and published Canadian AQHI. Availability depends on evidence
that meets each method's requirements. A supported method does not establish
local coverage or a calculable index at every point in that country.

Available integrations use Open-Meteo/CAMS, OpenAQ, UK-AIR and ECCC. OpenAQ
requires credentials. OpenMapX's source policy restricts Open-Meteo's free tier
to non-commercial deployments. Direct AirNow, EEA ground-observation and EEA
raster providers are not implemented.

## What a result means

A result can contain several evidence records:

- official agency or community publications;
- qualifying reference/regulatory ground-monitor concentrations;
- modeled grid evidence, currently including Open-Meteo/CAMS;
- raw pollutant values when a complete regional index cannot be calculated.

The headline identifies the selected local index when it can be calculated or
accepted from a qualifying publication. If only raw concentrations qualify,
OpenMapX shows those without assigning an index category. Incomplete observation
windows can prevent an index from being available.

In the UK, an official UK-AIR station DAQI can headline only when the station is
within 25 km. In Canada, ECCC's nearest named-community values are retained as
secondary evidence because the current GeoMet contract does not prove that the
community covers the requested point or identify conventional AQHI versus
AQHI+ per record.

Each record discloses whether it is ground, model, or hybrid evidence; who owns
and republishes it; the observation/forecast/validity times; spatial support;
quality and freshness; original units; method revision; source URLs, license,
and attribution. Open-Meteo's own European and US AQI fields are shown only as
provider-native methods. They are not labelled as reviewed OpenMapX standards.

## Air quality at a place

Expand **Air quality** below Weather in a place panel to load the canonical
result for that location. The section is lazy: merely opening a place does not
make an air-quality request. Its headline always remains the locally applicable
program selected by the server. If no qualifying local index can be produced,
the panel says so and shows the selected raw concentration instead of assigning
it an invented category.

Ground-monitor, model, and hybrid evidence stay in separate cards. Each card
names its basis and quality status and shows the available observation or
forecast time, validity, freshness, monitoring location or model grid, distance,
station class, pollutant completeness, and estimated or gap-filled flags. Source
owner, provider, license, direct attribution, and methodology links travel with
the evidence. Preliminary, stale, partial, and provider-degraded results remain
visible as such rather than being styled as fully verified readings.

The comparison menu can request one of the other supported standards without
replacing the local headline. The choice lasts only while the place panel is
mounted; it is not put in the URL, browser storage, or user profile. If the
requested method cannot be applied, the panel reports that the comparison is
unavailable and, when known, explains which evidence requirement was missing.

The optional **48-hour forecast** is fetched only after you expand it. Forecast
frames explicitly say whether they are available, partial, or unavailable, and
each canonical ground or model series is rendered independently. OpenMapX does
not draw a continuous line between unrelated sources or fill missing hourly
categories from a daily publication.

The separate [air-quality monitor map](./air-quality-map.md) plots raw station
concentrations with freshness, quality, and provenance signals. Its continuous
colors are deliberately not AQI health categories.

Category names and status text accompany color so you can read the result
without interpreting the color scale alone.

## Availability and degraded results

A complete response can contain fresh raw concentrations without a regional
index. A partial result can retain useful evidence while a provider, comparison,
source restriction, or freshness problem prevents a complete answer. Unavailable
means no eligible evidence was found; it does not mean the air is clean.

Forecasts follow the source's validity intervals. A daily published category is
not expanded into invented hourly categories. Check each evidence card's method,
time, and spatial coverage, especially when comparing a modeled grid with a
ground monitor.

Developers should use the [air-quality integration reference](../developer/air-quality-integrations.md)
for evidence selection, response fields, and standard validation.

:::caution[Informational, not regulatory advice]
Air-quality readings and modeled forecasts can be delayed, incomplete, or
spatially unrepresentative. OpenMapX explains provenance and calculation status
but does not certify regulatory compliance or replace local health-agency
guidance.
:::
