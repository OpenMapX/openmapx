---
"@openmapx/mobility-core": minor
---

Default the shared-mobility source policy to `fanout` instead of `motis-first`. MOTIS ingests only a curated subset of GBFS feeds, while the direct GBFS adapter covers the full MobilityData registry (hundreds of operators per country); under `motis-first` the direct adapters were skipped whenever MOTIS reported "healthy" — including an empty-but-complete result for an area MOTIS has no feed for — which collapsed map coverage to MOTIS's handful of feeds. `fanout` queries MOTIS plus all direct GBFS and proprietary adapters and dedups (MOTIS stays authoritative for the operators it carries), restoring broad coverage. Set `SHARED_MOBILITY_SOURCE_POLICY` to override.
