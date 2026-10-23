---
title: ECCC named-community air-quality evidence
description: Why ECCC GeoMet values are useful secondary evidence but not a local AQHI headline.
---

# ECCC named-community air-quality evidence

OpenMapX consumes ECCC's official `aqhi-observations-realtime` and
`aqhi-forecasts-realtime` OGC API collections. Requests use a bounded 100 km
bbox, fixed collection URLs, runtime-validated GeoJSON, response byte and feature
limits, request deadlines, and short caches. Current records must be original,
latest observations; forecast records must be original and carry coherent
publication and forecast instants.

GeoMet publishes a stable five-character community ID, bilingual names, a
point, time, and numeric AQHI value. It does not publish either of the two
associations needed for a canonical local headline:

- an official polygon or point-to-community coverage lookup for the requested
  coordinate;
- an explicit conventional AQHI versus wildfire AQHI+ method identifier on
  each record.

The provider therefore returns the nearest named community only within 100 km,
sets `coversRequestedPoint` to false, records `nearest-community`, and leaves
`claimedStandardId` null. The numeric value is preserved without rounding or a
generated `10+` display. Canonical selection rejects it as unverified and
non-covering, and the Canadian jurisdiction resolver requires true coverage
before activating `ca-aqhi-current`.

Treat this as secondary evidence until the upstream coverage and method
contracts are available. Québec receives the same treatment; OpenMapX does
not replace Info-Smog with a nearest AQHI community.

The implementation is `integrations/air-quality-eccc/provider.ts`, with
`provider.test.ts` covering identity, bounded transport, publication/forecast
time rules, and the non-headline contract. Current collections are capped at
100 features/512 KiB and cached for five minutes; forecasts are capped at
5,000 features/four MiB and cached for ten minutes. A truncated or inconsistent
collection is rejected. These upstream limits are separate from canonical
response limits. Check the
[ECCC release status](../administration/air-quality-status/eccc.md) before
claiming deployment qualification.

- [ECCC AQHI open-data guide](https://eccc-msc.github.io/open-data/msc-data/aqhi/readme_aqhi_en/)
- [GeoMet AQHI observations](https://api.weather.gc.ca/collections/aqhi-observations-realtime)
- [GeoMet AQHI forecasts](https://api.weather.gc.ca/collections/aqhi-forecasts-realtime)
- [ECCC open-data licence](https://eccc-msc.github.io/open-data/licence/readme_en/)
