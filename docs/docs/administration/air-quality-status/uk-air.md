---
title: Air quality — UK-AIR
air_quality_component: uk-air
status: shipped
code_path: "integrations/air-quality-uk-air,packages/air-quality/src/standards/uk-daqi-current.ts"
manifest_paths: "integrations/air-quality-uk-air/manifest.json"
manifest_source_ids: "uk-air-current-site-levels"
standard_revision: "uk-daqi-2026-04-13"
terms_record: "https://uk-air.defra.gov.uk/about-these-pages"
fixture_metadata: "integrations/air-quality-uk-air/__fixtures__/metadata.json"
focused_test: "pnpm exec vitest run --project node integrations/air-quality-uk-air packages/air-quality/src/__tests__/uk-daqi-current.test.ts"
live_smoke_date: "2026-08-30"
legal_approval: "not-required"
blocker: "none"
---

# UK-AIR

**Status:** shipped
**Owner:** safe optional-provider addendum

OpenMapX consumes UK-AIR's explicit current-site DAQI publication and validates
its value, category, station identity, and time contract. The nearest station
is eligible only within 25 km and remains labelled preliminary. The SOS
concentration path is still unsuitable for recomputation because its sampled
SO2 cadence and quality semantics do not satisfy the DAQI adapter.
