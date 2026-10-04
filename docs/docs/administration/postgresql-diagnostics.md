---
title: PostgreSQL diagnostics and benchmarks
description: Opt-in PostgreSQL statement statistics and a disposable synthetic query baseline.
sidebar_position: 7
---

# PostgreSQL diagnostics and benchmarks

OpenMapX can enable `pg_stat_statements` on its PostgreSQL 18 / PostGIS service.
It is disabled by default. This provides cumulative statement counters and a
local benchmark harness; it does not change PostgreSQL memory, connection,
parallelism, WAL, checkpoint, or autovacuum defaults.

## Enable diagnostics

Set **PostgreSQL query diagnostics** (`PG_STAT_STATEMENTS`) in the PostGIS
service configuration, or set `SERVICE_POSTGIS_PG_STAT_STATEMENTS=true` in the
instance configuration. Regenerate/apply the service configuration and restart
PostGIS. Changing this setting requires a database restart because PostgreSQL
loads `pg_stat_statements` through `shared_preload_libraries`.

Startup creates the extension in `POSTGRES_DB` before marking the service
healthy. Existing data volumes are supported. An invalid flag, custom preload
command argument, alternate configuration-file or data-directory argument, or conflicting
existing preload setting fails startup rather than silently replacing it.
Custom PostgreSQL configurations should be reviewed by their operator before
enabling this switch.

The fixed diagnostic settings are:

- `shared_preload_libraries=pg_stat_statements`
- `compute_query_id=auto`
- `pg_stat_statements.track=top`
- `pg_stat_statements.track_utility=off`
- `pg_stat_statements.save=off`

Utility statements, including startup password synchronization, are excluded
from statement tracking. Statistics are not saved across server restarts.
The extension still holds normalized SQL text internally, and normalization
is not a guarantee that every literal is removed. Treat database access and
its data volume as sensitive. This is **not** an anonymous public telemetry
endpoint. Existing PostgreSQL log settings and historic files have their own
retention; disabling these diagnostics does not erase them.

## Collect a read-only snapshot

From a development checkout with dependencies installed, supply a connection
URI through `POSTGIS_DIAGNOSTICS_URL`, using your existing secret-management
mechanism, then run:

```sh
pnpm postgis-diagnostics > postgis-diagnostics.json
```

Keep connection URIs out of command-line arguments: package runners such as
`pnpm` can echo those arguments even when a command rejects them.

The collector uses fixed read-only SQL, one connection, a five-second connection
and statement timeout, and no statistics resets. It exports PostgreSQL version,
numeric settings, current-database counters, aggregated lock counts, reset and
eviction metadata, and at most 50 statements ordered by cumulative execution
time. It never selects representative SQL text, usernames, database names,
connection strings, or result rows. Query IDs are PostgreSQL fingerprints;
large counters remain decimal strings to avoid JavaScript precision loss.

The connecting role needs permission to read these statistics. Use an operator
connection whose access you have reviewed. Other databases require their own
extension installation; startup provisions only `POSTGRES_DB`. The command
reports unavailable diagnostics with a fixed error message and does not echo
connection failures or credentials. Aggregate usage and timing can still be
sensitive operational information; keep exported reports under operator control.

Statement statistics contain cumulative totals and means, not request p50/p95.
Comparing snapshots requires stable reset timestamps and no entry eviction.
The benchmark refuses counter deltas if either inventory exceeds its 50-entry
export cap or eviction/reset metadata changes. A live snapshot may be truncated;
its `statementCount` makes that visible. No live statistics are reset by this tool.

If you deliberately need a fresh live statistics window, an authorized operator
can run `SELECT pg_stat_statements_reset();` with a sufficiently privileged role.
This resets shared statistics and disrupts other observers; record the reset
and start a new comparison window. Do not compare counters across that boundary.
A PostgreSQL restart also begins a new window because `save=off`.

To disable instrumentation, set the switch to false, regenerate/apply the
configuration, and restart PostGIS. The extension may remain installed but is
inactive without preload. Export collection then reports unavailable diagnostics.
Dropping the extension is an optional operator action, not an automatic rollback.

## Run without a deployed OpenMapX instance

The benchmark provisions its own disposable PostgreSQL container. It uses the
immutable image digest in the PostGIS manifest, the production startup wrapper,
a two-core / 2 GiB limit, and invented deterministic fixtures. Docker must be
running and able to pull that image. No OpenMapX instance, provider credentials,
regional download, or operator database is needed. `DATABASE_URL` is ignored;
there is no external database-target argument.

From the repository root:

```sh
pnpm bench-postgis --smoke --output /tmp/openmapx-postgis-smoke-1
pnpm bench-postgis --output /tmp/openmapx-postgis-baseline-1
```

Use a new output directory for each run. Absolute output paths avoid ambiguity
when the package runner changes into the data-manager workspace. Both report files are published by one
directory rename after all cases and checks succeed. Existing output is never
overwritten. Failure or cancellation stops and removes the benchmark container
without publishing a success report. SIGINT/SIGTERM trigger cleanup; an
unrecoverable host/process kill relies on Testcontainers resource reaping.

Smoke mode uses 1,000 POIs, 1,000 API records, and 12 measured operations per
scenario. Baseline mode uses 100,000 POIs, 10,000 API records, and 100 operations.
Both run search, conflation, ingestion, cleanup, and API query shapes at worker
concurrency 1 and 4, with five warmups and deterministic result checks.
Fixtures include production Overture DDL, simplified lexical and API tables,
batched upserts, and obsolete-row deletion batches. H3 labels are synthetic
partition labels, not realistic geographic cells. Conflation includes a spatial
SQL proxy; production also scores matches in JavaScript.

Reports contain client p50/p95, throughput, sampled Docker CPU/memory and lock
maxima, buffer/temp/WAL counter deltas, numeric settings, sanitized EXPLAIN
plans, source and fixture checksums, and image/resource metadata. Plan capture
runs outside measurement windows; write plans execute inside a rolled-back
transaction. Rollback does not undo generated WAL. Observer queries contribute
to window-level statement counters. Sampling is nominally every 100 ms and can
miss peaks; reports include sample counts. Warmups mean this is not a cold-cache
benchmark. Run on an otherwise quiet host and compare repeated runs on the same
hardware and resource allocation.

The dated [local baseline report](https://github.com/OpenMapX/openmapx/blob/main/docs/benchmarks/2026-10-04-postgis-baseline/postgis-baseline.md)
is a synthetic query baseline. Its SQL provenance and simplifications are
recorded in the report. It cannot establish production capacity or justify
small/default/large deployment profiles. Those parts of issue #311 need real
regional data and representative traffic once an instance is available.

See [PostgreSQL 18 pg_stat_statements documentation](https://www.postgresql.org/docs/18/pgstatstatements.html)
for extension permissions, normalization, reset, and retention behavior.
