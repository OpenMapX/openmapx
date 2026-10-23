---
title: EEA air-quality data-use decision
description: Mandatory legal gate for the optional EEA categorical raster.
---

# EEA air-quality data-use decision

The recorded decision is blocked (30 August 2026). It has not been replaced by a later approval in these release records.

The reviewed service is the EEA ArcGIS ImageServer for the 2025 AQMobile
categorical European AQI mosaic. Its generic service metadata and the EEA legal
notice do not affirmatively authorize the complete OpenMapX operation: a
server-side proxy, nearest-neighbour derivative PNG generation, caching and
retention, commercial deployments, and the exact required notices. The service
also advertises `exportTilesAllowed: false`.

The plan requires a maintainer to record dataset-specific terms and approval
covering every operation above. The release record contains no such approval. No EEA raster provider, proxy, cache, tile or browser fallback was added. A future review must cite the service and CAMS dataset terms,
versions, attribution text, retention/deletion requirements, reviewer, date,
and explicit maintainer approval before changing the status.

Reassess these references during any new review; the dated decision does not claim their current contents were checked again.

- [EEA legal notice](https://www.eea.europa.eu/en/legal-notice)
- [Live service metadata](https://air.discomap.eea.europa.eu/arcgis/rest/services/AQMobile_2025/MOSAIC_NO2_AQI/ImageServer)
