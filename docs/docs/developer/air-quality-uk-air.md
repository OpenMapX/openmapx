---
title: UK-AIR provider review
description: Why the optional UK-AIR DAQI provider is blocked.
---

# UK-AIR provider review

**Decision:** blocked on 30 August 2026; no provider code exists.

The official SOS 2.0 capability document was retrieved from
`https://uk-air.defra.gov.uk/sos-ukair/service`. It exposes the Eionet pollutant
identifiers for SO2 (`1`), PM10 (`5`), O3 (`7`), NO2 (`8`), and PM2.5 (`6001`).
The supported REST facade was also reviewed. A bounded London Marylebone Road
SO2 response contained hourly values, not the 15-minute series needed for the
current DAQI maximum, and the value response had no per-sample quality flag.
Its advertised `license` extra was a placeholder URL, so the authoritative OGL
statement comes from the UK-AIR site rather than that field.

OpenMapX will not resample hourly SO2 into a 15-minute maximum, assume a quality
status, or scrape the public dashboard. Revisit when the official machine
contract exposes the required cadence and quality semantics. Any future XML
client must still reject DTD/entities and enforce byte, depth, element,
identifier, time-range, and spatial bounds.

- [UK-AIR Sensor Observation Service](https://uk-air.defra.gov.uk/data/about_sos)
- [UK-AIR licensing](https://uk-air.defra.gov.uk/about-these-pages)
