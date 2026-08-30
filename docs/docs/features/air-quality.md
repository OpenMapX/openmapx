---
title: Air quality
description: Regional air-quality standards, raw pollutant evidence, provenance, forecasts, and station coverage in OpenMapX.
sidebar_position: 12
---

# Air quality

OpenMapX treats air quality as evidence, not as one universal score. A location
is matched to its regional program and evaluated with that program's reviewed
method when enough suitable evidence exists. You can also request another
standard for comparison, but it remains secondary to the location's standard.

The initial canonical service supports the US EPA 2024 AQI, current EEA
European AQI, UK DAQI, India NAQI, China's HJ 633-2026, and published Canadian
AQHI. Canada requires a matching ECCC community report; a country boundary alone
is not enough to claim that community index.

## What a result means

A result can contain several evidence records:

- official agency or community publications;
- qualifying reference/regulatory ground-monitor concentrations;
- modeled grid evidence, currently including Open-Meteo/CAMS;
- raw pollutant values when a complete regional index cannot be calculated.

`primaryEvidenceId` identifies the record selected for the headline.
`primaryIndexId` identifies the regional index inside it. When the best honest
answer is a raw concentration, the evidence ID is present and the index ID is
null. OpenMapX does not turn a partial window into a different index merely to
avoid an empty badge.

Each record discloses whether it is ground, model, or hybrid evidence; who owns
and republishes it; the observation/forecast/validity times; spatial support;
quality and freshness; original units; method revision; source URLs, license,
and attribution. Open-Meteo's own European and US AQI fields are shown only as
provider-native methods. They are not labelled as reviewed OpenMapX standards.

## Availability and degraded results

`ok` means the available result is internally complete for what it reports.
Fresh raw evidence can therefore be `ok` even without a regional index.
`partial` means useful data remains but a provider, requested comparison,
freshness, source policy, conflict, or bounded-response condition degraded it.
`unavailable` means no eligible evidence was found. Missing data is not returned
as an unlabeled 204 response.

Forecast frames follow provider-declared validity intervals. OpenMapX does not
interpolate an official daily category into invented hourly categories. Station
maps expose only bounded GeoJSON summaries—never internal pollutant time
series—and deterministically thin dense viewports.

:::caution[Informational, not regulatory advice]
Air-quality readings and modeled forecasts can be delayed, incomplete, or
spatially unrepresentative. OpenMapX explains provenance and calculation status
but does not certify regulatory compliance or replace local health-agency
guidance.
:::
