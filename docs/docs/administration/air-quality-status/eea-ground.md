---
title: Air quality — EEA ground observations
air_quality_component: eea-ground
status: blocked
code_path: "none"
manifest_paths: "none"
manifest_source_ids: "none"
standard_revision: "eea-eaqi-2026-08-29"
terms_record: "https://www.eea.europa.eu/en/datahub/datahubitem-view/778ef9f5-6293-4846-badd-56a29c70880d"
fixture_metadata: "none"
focused_test: "not-run-stop-gate"
live_smoke_date: "2026-08-30"
legal_approval: "not-required"
blocker: "The documented EEA service is an asynchronous bulk Parquet download workflow rather than a bounded point API; shipping raw UTD therefore requires a separately operated ingestion/store pipeline, while the viewer's per-sample CAMS gap-fill identity remains unavailable."
---

# EEA ground observations

**Status:** blocked
**Owner:** optional EEA ground implementation plan

The source-contract STOP condition remains reached for a request-time provider.
Raw UTD is reusable, but it must first be ingested, validated, stored, and
served by a background pipeline with explicit freshness and provenance. That
is a separate operational component, not a safe shortcut inside a user request.
OpenMapX does not scrape the EEA dashboard or label raw UTD downloads as the
hybrid, gap-filled viewer feed. See the
[provider review](../../developer/air-quality-eea-ground.md).
