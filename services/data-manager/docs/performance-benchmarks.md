# Data-manager performance benchmarks

These opt-in benchmarks use synthetic inputs and stay outside the normal test
suite and CI. Run them from the repository root with the workspace's Node version
and installed pnpm dependencies:

```sh
pnpm --filter @openmapx/data-manager bench:live-writer
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

Compare results on the same machine under similar load. Timings are comparison
evidence, not CI thresholds or proof of production performance.
