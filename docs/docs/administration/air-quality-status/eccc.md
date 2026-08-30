---
title: Air quality — ECCC named-community evidence
air_quality_component: eccc
status: shipped
code_path: "integrations/air-quality-eccc,integrations/air-quality/current.ts,integrations/air-quality/forecast.ts,packages/air-quality/src/types.ts,packages/air-quality/src/api.ts,apps/web/src/components/panels/place/PlaceAirQuality.tsx"
manifest_paths: "integrations/air-quality-eccc/manifest.json"
manifest_source_ids: "eccc-aqhi-geomet"
standard_revision: "unclaimed-eccc-geomet-method-2026-08-30"
terms_record: "https://eccc-msc.github.io/open-data/licence/readme_en/"
fixture_metadata: "integrations/air-quality-eccc/__fixtures__/metadata.json"
focused_test: "pnpm exec vitest run --project node integrations/air-quality-eccc integrations/air-quality/current.test.ts packages/air-quality/src/__tests__/api-schema.test.ts"
live_smoke_date: "2026-08-30"
legal_approval: "not-required"
blocker: "none"
---

# ECCC named-community evidence

**Status:** shipped
**Owner:** safe optional-provider addendum

The bounded GeoMet current and forecast collections are shipped as official
named-community evidence. OpenMapX reports distance, sets
`coversRequestedPoint: false`, uses the explicit `nearest-community` relation,
and leaves the standard and AQHI/AQHI+ method unclaimed. These values cannot
activate Canada's local AQHI resolver or become a headline index. The evidence
card explicitly warns that the community value does not establish coverage for
the selected point. This shipped scope therefore preserves useful official
evidence without pretending that the two missing upstream associations exist.
