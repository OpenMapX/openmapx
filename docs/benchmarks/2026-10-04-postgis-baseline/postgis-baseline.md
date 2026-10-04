# Synthetic PostGIS baseline report

Generated: 2026-10-04T01:12:45.342Z

Checkout commit: `12804f978de880ce09dc7ddbefd030575302df6e`; uncommitted checkout changes: true; SHA-256 source checksum: `a181644acace033c362777dd4550a63d938c6c737461c61374318f4a7e957d23`.

**This is a disposable-container synthetic query baseline, not production OpenMapX performance. No tuning profiles are justified by this run alone.**

## Environment

- image: `ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8`
- architecture: `aarch64`
- dockerOperatingSystem: `linux`
- dockerCpuCount: `10`
- dockerMemoryBytes: `8319504384`
- containerMemoryBytes: `2147483648`
- containerCpuLimit: `2`
- postgresVersionNum: `180006`
- postgisVersion: `3.6.4`

## Fixture and methodology

- Fixture revision 1, seed 1; 100000 invented POIs and 10000 invented API records.
- Fixture configuration checksum: `9b4e7ca5362e831811e824f830ce59ffc765733645a878df9e6142fb4ddc703d`. Ordered fixture data checksum (MD5): `9e95bf76da8a20b0c7f2efd69fe4d48c`.
- Fresh container, analyzed/indexed fixtures; five warmup operations before each scenario. No cold-cache claim.
- p50/p95 are nearest-rank percentiles of individual client wall-clock operation samples. A family operation may execute multiple queries.
- Worker concurrency is 1 or 4; throughput uses the whole measurement window. Fixture/reset and independent EXPLAIN windows are excluded.
- Resource and lock observations are sampled at a nominal 100 ms interval plus initial/final observations. Actual acquisition can take longer; sampled maxima are not exact peaks. CPU 100% means one core; the container limit is two cores. Memory includes cache.
- Counter deltas include measurement observer queries; they are window-level statistics, not per-request attribution. Top-50 retention and reset validity are checked.
- EXPLAIN ANALYZE executes on synthetic data only. Write plan capture is rolled back; rollback does not undo WAL. Literal expressions and relation names are removed from exported plans.
- Smoke mode is a correctness/instrumentation check and is unsuitable for tuning comparisons.

## Measurements

All scenarios passed result correctness checks.

| Workload   | Workers | Samples |  p50 ms |  p95 ms |  Ops/s | Shared reads | Temp writes | WAL bytes | CPU max % | Memory max MiB | Waiting locks max |
| ---------- | ------: | ------: | ------: | ------: | -----: | -----------: | ----------: | --------: | --------: | -------------: | ----------------: |
| search     |       1 |     100 |  36.525 |  61.422 |   25.2 |            0 |           0 |         0 |     190.5 |          381.9 |                 0 |
| search     |       4 |     100 | 116.011 | 193.394 |   30.1 |            0 |           0 |         0 |     346.9 |          439.1 |                 0 |
| conflation |       1 |     100 |   3.195 |   6.168 |  279.9 |            0 |           0 |         0 |      53.0 |          412.3 |                 0 |
| conflation |       4 |     100 |   4.773 |   6.897 |  802.6 |            0 |           0 |         0 |     156.8 |          412.3 |                 0 |
| ingestion  |       1 |     100 |   1.156 |   2.941 |  688.0 |            0 |           0 |    206394 |      26.1 |          412.9 |                 0 |
| ingestion  |       4 |     100 |   2.677 |   5.614 | 1355.3 |            0 |           0 |    204961 |      51.3 |          413.7 |                 0 |
| cleanup    |       1 |     100 |   1.192 |   3.074 |  687.9 |            0 |           0 |     55004 |      23.3 |          413.9 |                 0 |
| cleanup    |       4 |     100 |   2.293 |   5.883 | 1458.6 |            0 |           0 |     54956 |      49.8 |          413.4 |                 0 |
| api        |       1 |     100 |   1.653 |   4.610 |  469.5 |            0 |           0 |         0 |      23.4 |          413.7 |                 0 |
| api        |       4 |     100 |   4.510 |   9.811 |  737.7 |            0 |           0 |         0 |      64.0 |          413.8 |                 0 |

## Query provenance and simplifications

- **search:** integrations/search-osm-aliases/provider.ts: lexical join/proximity; simplified single exact alias and PostGIS geometry bbox.
- **conflation:** services/data-manager/src/jobs/overture/conflate.ts: H3-blocked candidate retrieval; extra indexed spatial join is a database-only scoring proxy, not full JS matching.
- **ingestion:** services/data-manager/src/jobs/overture/schema.ts and extract-osm-pois.ts: batched insert/conflict updates; synthetic stable IDs.
- **cleanup:** apps/api/src/services/activity-retention.ts: age-filtered retention deletions; bounded synthetic obsolete-row batches, not complete retention jobs or Overture filesystem pruning.
- **api:** apps/api/src/db/saved-schema.ts and admin-job-schema.ts: owner-scoped list reads and status-filtered job reads; reduced synthetic schema.

## Interpretation and next steps

Production PostgreSQL defaults remain unchanged. The suite covers specified database query shapes, not network traffic, complete provider adapters, real regional distributions, or end-to-end ingestion. Repeat on the same resource allocation for candidate settings, then evaluate real regional data and representative traffic before recommending small/default/large deployment profiles. Timing thresholds are not portable correctness gates. Full settings, sanitized plans, resource sample counts, and counter deltas are in the companion JSON report.
