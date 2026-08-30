---
title: Air quality — AirNow
air_quality_component: airnow
status: blocked
code_path: "none"
manifest_paths: "none"
manifest_source_ids: "none"
standard_revision: "epa-aqi-tad-2024-05"
terms_record: "https://docs.airnowapi.org/account/request/"
fixture_metadata: "none"
focused_test: "not-run-stop-gate"
live_smoke_date: "2026-08-30"
legal_approval: "missing"
blocker: "The bulk files expose reporting-area name/state but no stable reporting-area code, while the documented by-code API contract and Data Use Guidelines require an approved account/API key and operator notification obligations not recorded for this project."
---

# AirNow

**Status:** blocked
**Owner:** optional AirNow implementation plan

Official `reportingarea.dat` and `cityzipcodes.csv` were reviewed on 30 August
2026. They avoid retiring coordinate services, but cannot satisfy the approved
stable-code identity and governance design without an approved AirNow account.
No centroid fallback or unpublished API contract was implemented.
