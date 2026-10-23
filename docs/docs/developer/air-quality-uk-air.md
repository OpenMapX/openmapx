---
title: UK-AIR provider review
description: Contract, safeguards, and limitations of the UK-AIR current-site DAQI provider.
---

# UK-AIR provider review

The built-in `air-quality-uk-air` integration reads the official current-site
DAQI feed. Its recorded provider review dates to 30 August 2026; that review
does not establish qualification of the current deployment. Check the
[UK-AIR release status](../administration/air-quality-status/uk-air.md) for
release requirements.

The provider reads the official bounded RSS publication at
`/assets/rss/current_site_levels.xml`. It validates the stable site ID, DMS
coordinates, agency-published band and 1 to 10 index, observation time, and feed
build time. It does not calculate a pollutant index. The nearest site is used
only within 25 km, where the evidence explicitly records a nearest-station
association; it is preliminary official ground evidence rather than a
regulatory-compliance determination.

Transport is fixed-origin, redirect-denying, and capped at 256 KiB. XML is
validated, custom entity declarations are rejected, site count is bounded, and
malformed records cannot become evidence. OpenMapX caches the parsed feed for 120 seconds. The observation validity
window is two hours; cache age and observation age are separate. Stable OpenMapX observation and index IDs are
derived from the public site ID and observation time.

## Why SOS is still not used

During the recorded review, the official SOS 2.0 capability document was retrieved from
`https://uk-air.defra.gov.uk/sos-ukair/service`. It exposes the Eionet pollutant
identifiers for SO2 (`1`), PM10 (`5`), O3 (`7`), NO2 (`8`), and PM2.5 (`6001`).
The supported REST facade was also reviewed. A bounded London Marylebone Road
SO2 response contained hourly values, not the 15-minute series needed for the
current DAQI maximum, and the value response had no per-sample quality flag.
Its advertised `license` extra was a placeholder URL, so the authoritative OGL
statement comes from the UK-AIR site rather than that field.

OpenMapX still will not resample hourly SO2 into a 15-minute maximum, assume a
quality status, or scrape the public dashboard. UK-AIR publishes the final station DAQI explicitly in RSS. This avoids
reconstructing an index from incomplete SOS windows; it does not establish
conformance of those raw series.

Maintain `integrations/air-quality-uk-air/provider.ts` and its adjacent tests
together. Test malformed XML, inconsistent bands/times, distance limits,
response bounds, and cancellation before changing the parser or transport.

- [UK-AIR Sensor Observation Service](https://uk-air.defra.gov.uk/data/about_sos)
- [UK-AIR licensing](https://uk-air.defra.gov.uk/about-these-pages)
- [Current site-level RSS](https://uk-air.defra.gov.uk/assets/rss/current_site_levels.xml)
