---
title: EEA ground-provider review
description: Why the optional official EEA UTD/hybrid provider is blocked.
---

# EEA ground-provider review

**Decision:** blocked on 30 August 2026; no provider code exists.

The EEA Air Quality Download Service is a documented, CC BY 4.0 source for raw
verified and up-to-date observations. The public European AQI viewer separately
documents CAMS gap filling. The review did not find a stable, documented,
bounded station endpoint that joins those contracts while preserving station
classification and a per-sample distinction between preliminary UTD values and
each CAMS-filled value. The approved plan forbids dashboard-request discovery
and scraped fallbacks.

Revisit only when an official documented endpoint exposes the station class,
pollutant unit/cadence, quality status, and gap-fill flag or method. Until then,
OpenAQ remains the truthful ground source and Open-Meteo/CAMS remains separately
identified model evidence.

- [EEA Air Quality Download Service](https://www.eea.europa.eu/en/datahub/datahubitem-view/778ef9f5-6293-4846-badd-56a29c70880d)
- [European Air Quality Index methodology](https://airindex.eea.europa.eu/AQI/?webgl=0)
