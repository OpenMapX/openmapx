---
title: Air quality — base platform
air_quality_component: base
status: shipped
code_path: "integrations/air-quality,integrations/overlay-air-quality,integrations/weather-open-meteo-air-quality,packages/air-quality"
manifest_paths: "integrations/overlay-air-quality/manifest.json,integrations/weather-open-meteo-air-quality/manifest.json"
manifest_source_ids: "openaq,open-meteo-air-quality"
standard_revision: "epa-aqi-tad-2024-05,eea-eaqi-2026-08-29,uk-daqi-2026-04-13,cpcb-naqi-2014,hj633-2026,eccc-aqhi-2026-08-29"
terms_record: "integrations/overlay-air-quality/manifest.json,integrations/weather-open-meteo-air-quality/manifest.json"
fixture_metadata: "integrations/overlay-air-quality/__fixtures__/metadata.json,packages/air-quality/src/data/standards/epa-aqi-tad-2024-05.json"
focused_test: "pnpm test --project node -- packages/air-quality integrations/overlay-air-quality integrations/weather-open-meteo-air-quality integrations/air-quality"
live_smoke_date: "2026-08-30"
legal_approval: "not-required"
blocker: "none"
---

# Base platform

**Status:** shipped
**Owner:** plans 01–06 and closeout plan 11

The governed provider runtime, evidence/standards domain, jurisdiction artifact,
OpenAQ ground evidence, canonical current/forecast/station APIs, Open-Meteo/CAMS
model evidence, place panel, and monitor map are released together. OpenAQ
remains credential-gated. Open-Meteo free-tier use remains non-commercial and
is governed by the operator data-use policy.
