# Measuring CI performance

Keep the required `lint / types / test` context and its full validation coverage
while optimizing CI. Measure queue delay, execution time and summed runner time
separately. A faster cache export can still make the next build slower.

## API cache export policy

API validation and trusted image builds export the minimal cache (`mode=min`).
They keep the existing `api` scope and cache imports. Other image targets retain
`mode=max`; this experiment measured the API only. Release provenance, SBOMs,
scans and the full required validation gate remain in place.

The [qualification run](https://github.com/OpenMapX/openmapx/actions/runs/39052091932)
at revision `c710f887e0e89085018e4e3b10a78a1ed89d570d` completed all nine
builds and validated comparable inputs, resolved materials and toolchains:

| Policy                      | Cold build (s) | Unchanged build (s) | Source-only build (s) | Chain action time (s) |
| --------------------------- | -------------: | ------------------: | --------------------: | --------------------: |
| max                         |         470.91 |               59.29 |                130.44 |                663.33 |
| min                         |         156.13 |               63.25 |                111.20 |                332.46 |
| no PR export, no main cache |         113.28 |              105.97 |                103.82 |                325.26 |

The [two-replicate comparison](https://github.com/OpenMapX/openmapx/actions/runs/39053132883)
used the same revision. All 18 builds and the comparison validator passed.
Phase medians and mean times per three-build chain were:

| Policy                      | Cold median (s) | Unchanged median (s) | Source-only median (s) | Mean chain action time (s) | Mean worker time (s) |
| --------------------------- | --------------: | -------------------: | ---------------------: | -------------------------: | -------------------: |
| max                         |          442.70 |                56.11 |                 124.68 |                     626.12 |               685.50 |
| min                         |          171.68 |                52.71 |                 126.22 |                     353.30 |               440.00 |
| no PR export, no main cache |          106.83 |                99.11 |                  97.19 |                     305.51 |               424.50 |

The cold export median fell from 343.78 to 58.87 seconds. The source-only build
median differed by 1.54 seconds. These controlled chains support reducing API
export overhead; they do not establish an overall CI speedup or a production
percentile.

Build durations include cache export. Chain action time sums the three build
intervals; complete worker time also includes setup, collection and cleanup.
The qualification used 1,659 summed worker seconds. It is a single sample,
not a production CI percentile. The release planner cold-builds an image when its last cold refresh is
at least seven days old; that clock is unchanged.

`min` reduces the existing export overhead while preserving fast unchanged
rebuilds. The no-export baseline used fewer worker seconds, but its unchanged
build median was 46.40 seconds slower than `min`. It did not restore a real
trusted-main cache. Selecting a trusted-main-only policy would require that
qualification; these results do not reject it as a possible further improvement. Measure at least ten comparable normal CI runs
before reporting p50/p90 improvement. Re-evaluate the cache choice after changes
to the Dockerfile layout or build toolchain.

## API cache experiment

The manual **Measure Docker cache policies** workflow compares API cache-only
builds with three policies:

- `max`: export intermediate and final build cache.
- `min`: export the minimal build cache.
- `main-only`: export no PR cache. This experiment starts without a trusted-main
  cache, so it measures the conservative case where there is nothing to reuse.
  Qualify real main-cache reuse before rejecting this policy on that result.

Each replicate runs a cold security refresh, a following unchanged build, and a
following source-only build. A fresh pinned BuildKit builder handles each case;
local state cannot masquerade as remote reuse. The final case appends a comment
only to the disposable checkout's API source. It changes no application behavior.

Every run uses its exact Git revision, locked dependencies, pinned BuildKit,
Dockerfile frontend and SBOM generator. Receipts include the source tree and diff
hashes, resolved image materials, per-vertex durations, cache export time, cache
hits, exact local BuildKit cache bytes, action time and worker execution time.
Different inputs, toolchains, missing cases or failed workers invalidate the
comparison. Cache scopes include run, attempt, policy and replicate identifiers;
the experiment never imports or overwrites the production `api` scope.

The workflow runs only when requested, with one or two replicates per policy
(9 or 18 API builds). Start with one to qualify the environment, then use two
for comparison. Maximum concurrency is three workers. A worker times out after
45 minutes, and each case removes its own builder after collecting evidence.

After this workflow exists on `main`, run:

```bash
gh workflow run docker-cache-benchmark.yml --ref main -f samples=1
gh run list --workflow docker-cache-benchmark.yml --event workflow_dispatch --limit 5
```

GitHub requires a workflow with `workflow_dispatch` to be present on the default
branch before it can be triggered. Rerun all jobs at the same revision for another
sample; attempt-specific scopes prevent stale experiment caches from becoming a
false cold baseline. Rerunning only failed jobs cannot produce a complete new
attempt and is intentionally rejected. Run-start delay is reported only for a
first attempt; GitHub retains the original creation timestamp for reruns.

The run summary and `cache-comparison-<run>-<attempt>` artifact contain the
comparison and raw measurement receipts. Partial receipts remain available after
failure. An unsuccessful matrix, missing sample or inconsistent source does not
produce a successful comparison.

## Interpreting the results

Compare the complete cold → unchanged → source-only chain, not just its first
export. Include all benchmark workers when calculating runner cost. BuildKit
vertex spans can overlap; do not add every vertex duration as if they were
serial. The report counts only the outer GitHub cache-export vertex.

Local cache bytes measure builder storage. The repository-wide cache byte count
is an observation of shared storage, which other workflows can change. Neither
is the exact remote blob footprint attributable to one scope; an index key's
size alone does not establish that footprint. An unchanged build with no export
can also be cold when a trusted-main cache is unavailable.

These are cache-only measurements, not release publication or deployment
rehearsals. Production provenance, SBOM generation, vulnerability scans and
publication gates stay in the existing release workflow. The experiment
publishes no container images or tags and grants no package-write permission.
A policy change needs a separate PR backed by the measured chains. Follow it
with at least ten comparable normal CI runs before reporting p50/p90 improvement.

References: [Docker cache modes](https://docs.docker.com/build/cache/backends/),
[GitHub cache backend](https://docs.docker.com/build/cache/backends/gha/),
[BuildKit history](https://docs.docker.com/reference/cli/docker/buildx/history/inspect/),
and [manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
