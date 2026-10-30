---
title: EEA air-quality data-use decision
description: Why OpenMapX does not provide an EEA categorical raster layer.
---

# EEA air-quality data-use decision

OpenMapX does not implement an EEA categorical raster provider, proxy, cache,
tile endpoint or browser fallback. Dataset-specific permission has not been
established for server-side proxying, derivative PNG generation, caching,
retention and commercial use.

A publicly reachable service or its generic metadata does not establish
permission for those operations. Check the dataset and CAMS terms, required
notices and allowed operations before adding an integration or configuring a
replacement source. Current EEA-related support consists of regional index
calculations from qualifying evidence; it does not include the EEA viewer's
raster feed.

- [EEA legal notice](https://www.eea.europa.eu/en/legal-notice)
- [Live service metadata](https://air.discomap.eea.europa.eu/arcgis/rest/services/AQMobile_2025/MOSAIC_NO2_AQI/ImageServer)
