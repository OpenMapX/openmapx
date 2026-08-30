---
title: Air quality — UK-AIR
air_quality_component: uk-air
status: blocked
code_path: "none"
manifest_paths: "none"
manifest_source_ids: "none"
standard_revision: "uk-daqi-2026-04-13"
terms_record: "https://uk-air.defra.gov.uk/about-these-pages"
fixture_metadata: "none"
focused_test: "not-run-stop-gate"
live_smoke_date: "2026-08-30"
legal_approval: "not-required"
blocker: "The official SOS exposes all five pollutant identifiers, but sampled live SO2 series are hourly rather than the 15-minute maximum required by DAQI and values carry no per-sample quality flag."
---

# UK-AIR

**Status:** blocked
**Owner:** optional UK-AIR implementation plan

The capability and one bounded time series were reviewed on 30 August 2026.
The service is OGL-licensed, but its current contract cannot produce coherent
DAQI inputs without inventing cadence or quality. See the
[provider review](../../developer/air-quality-uk-air.md).
