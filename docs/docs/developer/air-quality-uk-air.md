---
title: UK-AIR provider review
description: Contract, safeguards, and limitations of the UK-AIR current-site DAQI provider.
---

# UK-AIR provider review

The built-in `air-quality-uk-air` integration reads the official current-site
DAQI feed.

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

The provider uses the published station index rather than reconstructing DAQI
from SOS concentration series. OpenMapX requires 15-minute SO2 samples and
explicit quality information for that calculation; hourly samples cannot
establish the required maximum. The integration does not resample hourly SO2,
assume missing quality flags or scrape the dashboard.

Maintain `integrations/air-quality-uk-air/provider.ts` and its adjacent tests
together. Test malformed XML, inconsistent bands/times, distance limits,
response bounds, and cancellation before changing the parser or transport.

- [UK-AIR Sensor Observation Service](https://uk-air.defra.gov.uk/data/about_sos)
- [UK-AIR licensing](https://uk-air.defra.gov.uk/about-these-pages)
- [Current site-level RSS](https://uk-air.defra.gov.uk/assets/rss/current_site_levels.xml)
