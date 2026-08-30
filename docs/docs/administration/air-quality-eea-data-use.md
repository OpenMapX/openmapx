---
title: EEA air-quality data-use decision
description: Mandatory legal gate for the optional EEA categorical raster.
---

# EEA air-quality data-use decision

**Decision:** blocked on 30 August 2026.

The reviewed service is the EEA ArcGIS ImageServer for the 2025 AQMobile
categorical European AQI mosaic. Its generic service metadata and the EEA legal
notice do not affirmatively authorize the complete OpenMapX operation: a
server-side proxy, nearest-neighbour derivative PNG generation, caching and
retention, commercial deployments, and the exact required notices. The service
also advertises `exportTilesAllowed: false`.

The plan requires a maintainer to record dataset-specific terms and approval
covering every operation above. No such approval exists in this repository or
implementation thread, so no endpoint, proxy, cache, tile, or browser fallback
was added. A future review must cite the service and CAMS dataset terms,
versions, attribution text, retention/deletion requirements, reviewer, date,
and explicit maintainer approval before changing the status.

- [EEA legal notice](https://www.eea.europa.eu/en/legal-notice)
- [Live service metadata](https://air.discomap.eea.europa.eu/arcgis/rest/services/AQMobile_2025/MOSAIC_NO2_AQI/ImageServer)
