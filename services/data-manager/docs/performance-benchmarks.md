# Data-manager performance benchmarks

These opt-in benchmarks use synthetic inputs and stay outside the normal test
suite and CI. Run them from the repository root with the workspace's Node version
and installed pnpm dependencies:

```sh
pnpm --filter @openmapx/data-manager bench:live-writer
pnpm --filter @openmapx/data-manager bench:overture-h3
```

## Live traffic writer

The writer benchmark needs no running services. It creates disposable traffic
archives with 10,000 tiles and 100,000 edges in an OS temporary directory, then
compares direct execution, a fresh worker, and reuse of that worker. It closes the
worker and removes its temporary files in `finally`; it does not use `DATA_DIR`
or operator traffic files.

Each mode prints one JSON result. `submissionMs` measures synchronous submission
cost, `wallMs` measures completion time, and `delayP95Ms` / `delayMaxMs` measure
event-loop delay. `written` checks the amount of work; `processPeakRssKiB` is the
process-wide high-water mark, so later modes inherit earlier peaks.

## Overture H3 writes

The H3 benchmark requires a running Docker daemon accessible to Testcontainers
and access to the helper's pinned PostGIS image. It creates its own disposable
PostGIS container with 100,000 synthetic rows and never uses `DATABASE_URL` or
imported data. The helper closes its SQL connection and stops the container in
`finally`.

Four JSON results compare baseline, keyset, keyset, and baseline traversal.
`batches` and `calls` describe database work; `readBuffers` counts shared buffer
hits and reads for selection plans. `elapsedMsIncludingExplain` includes the
additional `EXPLAIN ANALYZE` queries. `counts.remaining` should be zero and
`counts.prefilled` should stay unchanged. `plans` exposes sampled query plans for
the early and late batches.

Compare results on the same machine under similar load. Timings are comparison
evidence, not CI thresholds or proof of production performance.
