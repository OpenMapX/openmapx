---
title: Self-hosting workload replay
description: Disposable PostgreSQL comparisons with revision and fixture identities.
---

# Self-hosting workload replay

Run `scripts/self-hosting-replay.ts` through the existing CLI-scoped `tsx` runner.
It accepts two explicit isolated OpenConditions worktrees, commits their source
identity to the report and resolves dependencies before creating a database.
Install dependencies with `pnpm install --frozen-lockfile` in each OC worktree
before replay. The runner then executes the fixed command
`pnpm exec turbo run build --force --concurrency=1` in each validated clean root,
serially and before creating any container. Build failure aborts replay. If the
same output directory already contains a report from a successful build, it may
reuse those artifacts only after verifying the exact clean revisions, fixed
successful build command and every artifact hash. Missing or changed provenance
fails closed; use a fresh output directory to request a fresh build. Previous
workload results are never resumed: every invocation starts all selected scenarios
from fresh owned databases. It records
the command/result and all built artifact hashes, checks source identity after
building and checks both source and artifact identity again at the end. On a shared development host, serialize builds and use
`pnpm exec turbo run build --concurrency=1` to bound package build concurrency.

```sh
pnpm exec vitest run --config scripts/self-hosting-replay-vitest.config.ts --maxWorkers=1
pnpm exec tsc --noEmit --strict --target esnext --module esnext \
  --moduleResolution bundler --skipLibCheck \
  --typeRoots packages/cli/node_modules/@types --types node scripts/self-hosting-replay.ts
pnpm -C packages/cli exec tsx ../../scripts/self-hosting-replay.ts \
  --baseline-oc-root /absolute/isolated/oc-baseline \
  --candidate-oc-root /absolute/isolated/oc-candidate \
  --scenario all --postgres-major all --runs 5 \
  --output plans/replay-results
```

Output is relative to the OMX worktree containing the script, including when
launched from `packages/cli`. It is restricted to that worktree's ignored `plans`
directory and refuses symlink escapes. Reports contain counters and logical
hashes, not record payloads, query text, query parameters or connection strings.
`runs.json` retains every raw sample; `summary.json` summarizes completed runs.
Each invocation immediately replaces prior completion with `INCOMPLETE` reports
and a fresh matching `invocationId`, before validating source/build provenance.
Partial samples remain incomplete even when individual comparisons passed.
Reports are replaced atomically; `COMPLETE` is published only after every
comparison, owned database/container cleanup and final provenance checks succeed.
Consumers must require matching invocation IDs and `COMPLETE` in both files.
A failed or interrupted rerun cannot retain the prior successful summary.
Exact successful build provenance can still be reused after the existing
revision, command and artifact checks; workload samples are never reused.

The CLI rejects connection environment variables and arbitrary connection or
container flags. It never accepts an existing database. Each PostgreSQL major uses one harness-owned Testcontainers cluster. Every arm
gets a fresh migrated database, seeded from the same sanctioned fixture and
dropped before the next arm. No other workload shares that cluster.
The only permitted images are PostGIS 16/3.4 compatibility and the immutable
PostGIS 18/3.6 image used by the OMX database fixture. Actual server and PostGIS
versions are verified. Containers run sequentially and are stopped in `finally`.
No production data, reset, migration, extension installation or restart is part
of this workflow. The harness does not install dependencies or read env files.

The fixture hash includes the harness source as well as the imported fixture files.
Baseline and candidate revisions and fixture hashes must be stable throughout
the run. The same revision is permitted as a harness control; that is not evidence
of an optimization. Commit candidate source before replay. Baseline/candidate
order is randomized within each of at least five independent repetitions.
A disposable `replay_clock.now()` function and timestamp defaults bind SQL
insertion/scheduling time to the same logical clock as the writer. The owned
database defaults select this clock before migrations create defaults or data;
PostGIS is installed in `public` first. Both fixture and workload
connections explicitly select that schema before `pg_catalog` and set their clock
before the counter baseline; production schemas
and code are unchanged. Logical output is compared as ordered database rows with stable object keys;
freshness, canonical identities, revisions and history remain part of comparison.
A difference aborts acceptance. Native database suites remain the correctness
authority for rights, failure injection, concurrency and fusion edge cases.

Each run records the actual image/server identity, clock, warm policy, reset and
server-start identities, raw before/after counters, WAL and temporary bytes,
statement calls/rows/buffers, exact table counts and table insert/update/delete/HOT
counts. A changed reset identity or decreasing counter invalidates comparison.
Workload clients flush statistics and close before after-counters are collected.
The driver statement count and wall time cover only the workload. Database and
statement-statistics deltas also include the bounded observer/flush overhead,
which is identical between arms; they are not exact per-request attribution.
Cumulative counters and estimates are not per-poll rates. WAL is cluster-wide;
these fixtures own the whole cluster. Harness RSS is labelled separately from
server RSS and unavailable host-pressure metrics. PostgreSQL query IDs are not
compared across versions.

Decisions are recorded before measurement: zero unexplained correctness changes,
no missed publication deadlines, an initial/unaffected median regression ceiling
of 5% after variance analysis, and a 20% relevant-work target for substantial
migration/cache complexity. Synthetic storage fixtures do not model publication
deadlines or production-scale imports, so a control or noisy result remains
inconclusive. A deterministic scan/DML removal needs demonstrated avoided work
and no credible latency regression; query counts do not establish RAM savings.

Diagnostics is enabled only inside disposable replay containers. Planning stays
off and I/O timing remains off. This measures neither production activation nor
I/O timing overhead. Production activation and rollback follow the separate
[service diagnostics gate](../install/managing-services.md#postgresql-workload-diagnostics).
