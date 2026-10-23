---
title: Self-hosting workload replay
description: Disposable PostgreSQL comparisons with revision and fixture identities.
---

# Self-hosting workload replay

Compare two explicit, clean OpenConditions worktrees using sanctioned synthetic
fixtures in disposable PostgreSQL clusters. The runner records source, fixture,
build and artifact identities before accepting a comparison. It never connects
to an existing database or reads environment files.

## Prerequisites

- Two isolated OpenConditions worktrees with committed baseline/candidate source.
  Install locked dependencies in each with `pnpm install --frozen-lockfile`.
- OpenMapX dependencies, including the CLI-scoped `tsx` runner, and a working
  Docker/Testcontainers environment.
- No connection environment such as `DATABASE_URL`, `PGHOST` or `PGSERVICE`.
  Use a separate shell with those variables unset; the runner rejects them.
- An output directory inside this OpenMapX worktree's ignored `plans/` directory.
  Symlink escapes are refused.

## Run the replay

The runner builds each validated OpenConditions root serially with
`pnpm exec turbo run build --force --concurrency=1` before creating a container.
A build failure aborts replay. Keep other heavy builds serialized on a shared
host. The focused source checks below do not create a replay database; the final
command performs the workload:

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

`--scenario` accepts `initial`, `unchanged`, `expiry-only`, `observation-only`,
`changed`, `first-register-linking`, `complete-empty` or `all`.
`--postgres-major` accepts `16`, `18` or `all`; `--runs` accepts 5 to 100.
Output paths are relative to the OpenMapX worktree containing the script, even
when launched from `packages/cli`.

## Read reports and handle retries

`runs.json` retains raw samples and `summary.json` summarizes completed runs.
Both contain counters and logical hashes, excluding record payloads, query text,
parameters and connection strings. Require **matching `invocationId` values and
`COMPLETE` in both files** before using a result.

Each invocation first replaces completion with `INCOMPLETE` reports and a fresh
invocation ID. Partial comparisons remain incomplete. Reports are replaced
atomically; completion requires every comparison, owned-resource cleanup and final
source/artifact checks. A failed or interrupted rerun cannot leave the previous
successful summary accepted.

A prior successful build can be reused only from the same output directory after
verifying exact clean revisions, the fixed successful command and every artifact
hash. Missing or changed provenance fails; use a fresh output directory for a
fresh build. Workload samples are never reused. Every selected scenario starts
with fresh owned databases, even when build artifacts are reused.

## Database and comparison boundaries

The CLI rejects arbitrary connection/container flags. Each PostgreSQL major
uses one harness-owned Testcontainers cluster. Every arm
gets a fresh migrated database, seeded from the same sanctioned fixture and
dropped before the next arm. No other workload shares that cluster.
The only permitted images are PostGIS 16/3.4 compatibility and the immutable
PostGIS 18/3.6 image used by the OMX database fixture. Actual server and PostGIS
versions are verified. Containers run sequentially and are stopped in `finally`.
Production data and existing databases are outside this workflow. Migrations,
fixture seeding and diagnostic extensions run only in the owned disposable
cluster. The harness does not install dependencies or read env files.

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

## Interpret measurements

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

## Acceptance and limitations

Decisions are recorded before measurement: zero unexplained correctness changes,
no missed publication deadlines, an initial/unaffected median regression ceiling
of 5% after variance analysis, and a 20% relevant-work target for substantial
migration/cache complexity. Synthetic storage fixtures do not model publication
deadlines or production-scale imports, so a control or noisy result remains
inconclusive. A deterministic scan/DML removal needs demonstrated avoided work
and no credible latency regression; query counts do not establish RAM savings.

## Production diagnostics

Diagnostics are enabled only inside disposable replay containers. Planning stays
off and I/O timing remains off. This measures neither production activation nor
I/O timing overhead. Production activation and rollback follow the separate
[service diagnostics gate](../install/managing-services.md#postgresql-workload-diagnostics).
