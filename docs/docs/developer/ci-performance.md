# Measuring CI performance

Keep the required `lint / types / test` context and its full validation coverage
while optimizing CI. Measure queue delay, execution time and summed runner time
separately. A faster cache export can still make the next build slower.

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
