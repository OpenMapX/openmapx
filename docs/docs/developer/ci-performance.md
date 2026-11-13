---
title: Measuring CI performance
description: Current build-cache and release-planner contracts, with dated measurements and a repeatable CI comparison method.
---

# Measuring CI performance

Keep the required `lint / types / test` context and its full validation coverage
while optimizing CI. Measure queue delay, execution time and summed runner time
separately. A faster cache export can still make the next build slower.

## Measure a change

1. Select at least ten comparable normal CI runs before and after the change.
   Record revision, event, affected targets, toolchain, runner class, and cache
   availability.
2. Measure queue delay, required-gate elapsed time, and summed runner seconds
   separately. Keep failed, cancelled, and cold-refresh runs identifiable.
3. Inspect BuildKit step and cache-export times. A dependency install can miss
   because the cache was unavailable or because its inputs changed.
4. Confirm that the required `lint / types / test` aggregate still requires
   every applicable validation job. A timing improvement cannot remove coverage.

The receipts below describe earlier controlled experiments and replay estimates.
They are not fresh CI measurements or production latency percentiles.

## API cache export policy

API validation and trusted image builds export the minimal cache (`mode=min`).
They keep the existing `api` scope and cache imports. Other image targets retain
`mode=max`; the comparison measured the API only. Release provenance, SBOMs,
scans and the full required validation gate remain in place. The release planner
still cold-builds an image when its last cold refresh is at least seven days old.

At revision `c710f887e0e89085018e4e3b10a78a1ed89d570d`, the [qualification run](https://github.com/OpenMapX/openmapx/actions/runs/39052091932)
completed nine builds.
The [two-replicate comparison](https://github.com/OpenMapX/openmapx/actions/runs/39053132883)
at the same revision completed all 18 builds and validated comparable inputs,
resolved materials and toolchains. Each replicate measured a cold build,
an unchanged rebuild and a source-only rebuild, using isolated cache scopes
and a fresh builder for each build. The temporary benchmark tooling was removed
after collecting these results.

Phase medians and mean times per three-build chain were:

| Policy                      | Cold median (s) | Unchanged median (s) | Source-only median (s) | Mean chain action time (s) | Mean worker time (s) |
| --------------------------- | --------------: | -------------------: | ---------------------: | -------------------------: | -------------------: |
| max                         |          442.70 |                56.11 |                 124.68 |                     626.12 |               685.50 |
| min                         |          171.68 |                52.71 |                 126.22 |                     353.30 |               440.00 |
| no PR export, no main cache |          106.83 |                99.11 |                  97.19 |                     305.51 |               424.50 |

Build durations include cache export. Chain action time sums the three build
intervals; worker time also includes setup, collection and cleanup. These were
cache-only builds, not release publication or deployment rehearsals.

The cold export median fell from 343.78 to 58.87 seconds with `min`. The
source-only build median differed by 1.54 seconds. This supports reducing API
export overhead while preserving fast unchanged rebuilds. The no-export baseline
used fewer worker seconds, but its unchanged build median was 46.40 seconds
slower than `min`. It did not restore a real trusted-main cache; that policy
needs separate qualification and remains a possible further improvement.

These controlled samples do not establish an overall CI speedup or production
percentiles. Measure at least ten comparable normal CI runs before reporting
p50/p90 improvement. Re-evaluate the cache choice after changes to the Dockerfile
layout or build toolchain.

References: [Docker cache modes](https://docs.docker.com/build/cache/backends/)
and [GitHub cache backend](https://docs.docker.com/build/cache/backends/gha/).

## Release cache backend

Trusted main releases keep their layer cache in the registry, as
`ghcr.io/openmapx/<app>:buildcache`, with the same per-image modes. The shared
Actions cache is capped at 10 GB per repository. On 2026-10-20 it held 10.79 GB,
8.18 GB of it main BuildKit blobs, and the next release's ops-agent, API and
data-manager builds reused no step. A rebuilt layer is not byte-identical, so
every host update then downloaded nearly all layers again. Registry export uses
`ignore-error=true`: a cache-export failure does not fail release publication.
Missing cache entries can force a later cold build.
PR validation builds keep their PR-scoped Actions cache because PR jobs hold no
registry credentials. See the [registry cache backend](https://docs.docker.com/build/cache/backends/registry/).

## Dependency-layer inputs

The API and web images stage integration `package.json` files before installing
dependencies. The ops-agent and transitous-runner images stage only the manifests
of the workspace packages they use, so the dependency stage is scoped to those workspaces. The runtime-package
projection described below narrows the final image further.
[`COPY --parents`](https://docs.docker.com/reference/dockerfile/#copy---parents)
preserves their directory layout without copying source; these Dockerfiles require
the stable Dockerfile 1.20 frontend.

Source is copied into later build stages and, where loaded directly at runtime,
into the final image. The API needs both integration source and the production
workspace links; copying only the installed manifests would break its dynamic
integration loader.

When cache is available, a source-only edit should reuse the dependency-install
layers. A changed package manifest, lockfile or install configuration should
invalidate them. Cache eviction or a missing remote cache can still force a fresh
install; distinguish cache availability from input invalidation when measuring. Keep workspace
install lifecycle scripts independent of application source, or explicitly stage
the inputs they need before installation and verify the cache behavior again.
The external dependency build allowlist in `pnpm-workspace.yaml` still applies.

## Release planner inputs

The planner (`scripts/docker-release-plan.mjs`) rebuilds an image only when the
files its Dockerfile copies change; otherwise the release reuses the published
digest. Hosts then neither download nor restart that service.

- A `*` or `?` glob covers only what it matches: `packages/*/package.json` is the
  manifests, not every package's source.
- The bundle stages of ops-agent, data-manager and transitous-runner copy only
  the workspace packages their bundles reach, not all of `packages/` or
  `services/`.
- The lockfile counts only for what an image installs: the importers whose
  `package.json` it copies, the workspace importers they link, and every
  snapshot and package reachable from them, plus the lockfile settings. If the
  planner cannot follow an entry, it counts the whole file. The plan job installs
  the workspace for the `yaml` parser.
- `ci.yml` is not an input: it passes nothing to `docker.yml`.

In the recorded 200-main-commit planner replay, the same planner rules would have
rebuilt ops-agent 106 times instead of 139, transitous-runner 97 instead of 121,
data-manager 118 instead of 130, and transitous-tools 10 instead of 18. API and web include every integration and change
in most commits anyway. Most remaining rebuilds come from `packages/core`: every
image uses it, and ops-agent's CLI imports its barrel, which reaches about 1,000
of its files. File-level inputs would mostly help transitous-runner, which reaches
3 core files. They are not used, because computed imports and file reads cannot
all be followed, and a missed one would let a release reuse an image with stale code.

## Runtime bundles

ops-agent, data-manager and transitous-runner run runtime bundles with plain
`node` instead of workspace TypeScript under tsx. ops-agent ships its agent
(`dist/agent.mjs`), its configuration helper (`dist/configuration-handoff-main.mjs`)
and its fixed CLI (`dist/cli.mjs`). A recorded local measurement put bundled CLI startup at about 0.2 s versus
about 0.8 s under tsx, and the agent starts it for every CLI-backed operation.
data-manager ships its supervisor, the service it starts, and the live traffic
writer and offline package extractor worker threads.
A bundle evaluates all of its npm imports before any bundled code, so an import of
another entry's source loads that entry's output as its own module. data-manager's
`index.mjs` imports `undici-fetch.mjs` and then `service.mjs`: the fetch globals
are replaced before any module of the service is evaluated, as under tsx.
`scripts/build-runtime-bundles.mjs` bundles an image's own code and the
workspace code it reaches with esbuild:

- npm packages stay installed in the image, but every import is pinned. The script
  resolves it from the importing package's location with Node's conditions and
  main field, as Node does in the pnpm layout, and rewrites it to a path relative
  to the output directory. The bundle therefore loads the same dependency files
  as before.
- The image installs only the npm packages the bundle loads. The script follows
  every literal `import` and `require` from the pinned files through the
  installed packages and lists the package directories it reaches in
  `runtime-packages.json`. A computed `import()` or `require()` in any of them
  fails the build, because its targets cannot be listed. The image's
  `runtime-packages` stage runs `scripts/copy-runtime-packages.mjs` to copy
  those directories whole, so a package keeps the files it reads by path and
  its license, along with the node_modules links between them. It copies from
  the same install the `bundle` stage analyzed, so whether a workspace manifest
  lists a dependency as production or development does not change the image.
  A production install for these images would be about 870 MB, mostly web and
  mobile tooling that workspace manifests or peer dependencies pull in. The
  images keep 24 MB of it for transitous-runner, 43 MB for ops-agent and 70 MB
  for data-manager.
- A literal `new URL("…", import.meta.url)` asset is copied into `dist/assets/`.
  A URL naming another entry of the same bundle, such as a worker's source file,
  points at that entry's `.mjs` instead. `entryExecArgv` in data-manager adds tsx
  only when the entry is TypeScript source, in development and tests.
  A `require` created with `createRequire(import.meta.url)` may only be called with
  literal specifiers, which are pinned like imports.
- Workspace modules are treated as side-effect free. A module none of whose
  exports the bundle uses is left out, with the dependencies only it imports, so
  editing code a bundle does not use leaves the bundle unchanged. A module whose
  top-level code must run on import is an entry or is listed in its bundle's
  `sideEffectModules` (data-manager: its database module, which checks the
  production database secret). The build rejects any other module that runs
  top-level statements besides declarations, so the list cannot fall behind.
  It also rejects a listed module the bundle no longer includes.
- A bundle's `replaceModules` swaps a workspace module for a bundle variant.
  ops-agent replaces `embedded-built-in-services.ts`, which returns nothing, with
  `embedded-built-in-services.bundle.ts`, whose asset URLs embed every built-in
  `service.json`. Only the ops-agent bundle therefore embeds the manifests, and
  a manifest change rebuilds only that image. The build fails if a replacement is
  missing or nothing imports the replaced module.
- A computed `import()` or `require()`, any other use of `import.meta` or the
  module's location, and any esbuild warning fail the build. Among the warnings
  is a bare `import "…"` of a module not in `sideEffectModules`.
- `scripts/build-runtime-bundles.test.ts` checks byte-identical output across
  builds and checkout locations.

The release planner fingerprints a bundled image by its bundle digest instead of
by the stages that only feed the `bundle` stage. The digest also covers the
packages the image keeps: `runtime-packages.json` names each by its store
directory, which pins its version and peers. Package manifests and the lockfile
therefore count only through the digest. The exception is the root manifest's
`packageManager`, which selects the pnpm the base stage activates. A dependency
change that leaves every kept package as it was rebuilds none of these images.
In the recorded 200-main-commit replay, ignoring bundle changes, that
cut rebuilds from 34 to 20 for data-manager, 31 to 15 for ops-agent and 32 to
18 for transitous-runner. Some of the dropped rebuilds updated a kept package
and still rebuild through the digest: at most 6, 4 and 3 respectively.
The plan job builds the bundles. A release build passes the planned digest as
`EXPECTED_BUNDLE_DIGEST`, and the `bundle` stage fails when its bundle differs.
Pull-request image builds do not pass it, because their jobs have no workspace
install, so a difference between the image's partial install and the full one
only surfaces in the release build on main.
`runtime-externals.json` lists the dependency files the output loads, and the
runner checks that each exists among the copied packages.
`check-dockerfile-workspace-sync` builds every bundle, checks that the `bundle`
stage copies every file the bundle reads (sources, assets and tsconfig files),
and rejects a bundled runner that copies workspace source or the whole
dependency install.

In the recorded 200-main-commit replay, bundles would have rebuilt
transitous-runner 24 times instead of 97 (its bundle never changed; the rest are
Dockerfile, workflow and dependency changes), ops-agent 57 times instead of 106
and data-manager 58 times instead of 118. Leaving unused workspace modules out
brings the replay to an estimated 44 for ops-agent and 47 for data-manager. It
also makes the bundles smaller: the ops-agent CLI goes from 1.0 MB to 0.73 MB,
data-manager's service from 1.38 MB to 1.17 MB, and its traffic worker from
254 kB to 27 kB.

Changesets excludes package-root `Dockerfile` edits from release detection;
these private deployment-image changes do not need empty package notes. Source,
package manifests and nested Dockerfile fixtures still participate in the gate.
Lockfile changes, and dependency-only edits to the root manifest or to workspace
manifests with their own lockfile importer, count only where they change a
public package's resolved dependency tree. A public package's own manifest and
shipped template manifests always count.
The wider package/release baseline is handled separately.

## Linux deployment-user validation

The complete agent, core, data-manager and deployment-user selection runs across
two independent runners, each with one Vitest worker and an explicit file list. Keep the pinned Node image,
uid 1001, init process, umask `002`, test deadlines, no retries, and required result.
The union of actual installed-Vitest selections must equal the unsharded
selection. Vitest 5 file-only listing ignores its native shard option, so the
launcher partitions explicit files and verifies each resulting collection. More workers within one runner would reintroduce filesystem contention.

## Database groups and scenario partitions

| Logical group            | Partitions | Selection and prerequisites                                                                                                              |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `api-privacy`            | 2          | Explicit file partitions; migrated pinned PostGIS, auth/API/privacy/migration/platform recovery; extra image/mount probes once in part 1 |
| `ingestion`              | 2          | Explicit file partitions; owned PostGIS, pinned Transitous Python dependencies, accounting/search/catalog/native import recovery         |
| `configuration-recovery` | 4          | Expanded native scenario partitions; owned migrated schemas and independent host/process fixtures                                        |
| `coordinator-recovery`   | 4          | Expanded native lifecycle scenarios, including unchanged real SQL/wall-clock expiry waits                                                |
| `export-restore`         | 1          | Exact-image Dawarich, controller export and restore replay together                                                                      |

`scripts/database-test-shards.json` is the runner inventory. Group membership stays
in `database-test-groups.json`, validated against discovered opt-in suites. Every
runner has its own pinned PostgreSQL 18/PostGIS 3.6 service and migrations. Its
Testcontainers, directories and archives are owned independently; no mutable
fixture is shared between runners. The group launcher retains one file worker
and fail-fast within that runner; the matrix collects other runners after failure.

Recovery files are not mechanically copied or split. Runtime collection via
Vitest 5's `--no-static-parse` expands their conditional and parameterized cases;
the default static listing omits these suites and cannot establish coverage.
Deterministic longest-first placement uses recorded durations only as hints, with
new cases receiving a conservative default. The installed runtime's actual filtered
collection must equal the planned scenario set before execution. Sequential
lifecycle cases stay whole; no product clock, lease, assertion or timeout changes.

Every partition uploads a source-bound receipt with the full and selected inventory.
The aggregate requires all thirteen receipts and verifies that each group's union
is complete, disjoint and identical across runners. Missing/duplicate cases,
changed-source receipts, failed/cancelled jobs and unexpected skips fail the gate.
Fixtures and individual deadlines retain their existing budgets. The 90-minute
upper caps remain until hosted measurements justify lowering them; they are not a
performance target.

The large platform-runtime matrix now provisions a worker-owned migrated template
once and creates a fresh database clone per scenario. The template never consumes
an external `DATABASE_URL`; failed/unfinished clones are cleaned on worker teardown.
Isolation and cleanup are tested against real PostGIS. Migration acceptance and
`throughMigration` boundaries continue using genuine fresh migration histories.
The separate configuration fixture already creates fresh owned schemas and is not
silently changed to share state.

Run `pnpm test:database <group>` for the unsharded group,
`pnpm test:database coordinator-recovery 1/4` for an explicit partition, or omit
the group for the full serial union. Export/all require the real retained archive;
missing/empty inputs fail rather than selecting synthetic fallback. See
[Contributing](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#testing).

## Event, applicability and main scheduling policy

The selector reads the complete immutable Git diff, including old rename/deletion
paths, rather than GitHub's truncated path-filter/API result. Unknown inputs,
symlinks, incomplete comparisons and base retargets fail closed to full validation.
Only ordinary docs prose and narrowly scoped web-component/mobile-runtime leaves
are candidates for avoiding unrelated native jobs. Initially the selector records
`proposedScope` in shadow mode while running every check. After ten comparable
normal PRs, review dependency/asset evidence and approve `docs` first, then proven
`web`/`mobile` scopes in `scripts/ci-impact-rollout.json`. Only trusted main's policy
is read; missing/malformed policy and candidate policy edits cannot enable skips.
Relevant types, portable source contracts, actual builds and image scans remain.
Main push/schedule/manual events run the full union.
The aggregate requires positive success for each selected job and an expected skip
only for explicit inapplicability; malformed selection receipts cannot pass.

The already-required title context enforces current release classification. Its
privileged workflow executes trusted default-branch code only, disables install
scripts, reads candidate Git objects as data and rejects metadata identity races.
This check still runs on every body/title edit; successful code evidence never
substitutes for metadata validation.

Every PR CI suite now executes the fixed `lint / types / test` aggregate, including
metadata-only runs. Never rename or skip it to preserve an older green result.
PR #790 demonstrated why: code run
[42299510168](https://github.com/OpenMapX/openmapx/actions/runs/42299510168) and metadata
run [42301703153](https://github.com/OpenMapX/openmapx/actions/runs/42301703153) shared
head `fbe5fcf405d3b4df0ae595d772a9b436589614ca` and workflow ID `269416138`, but used
check suites `114612290559` and `114618154255`. The first had a successful aggregate;
the second had only a skipped, unevaluated name expression. Rule-suite audit
`4962325353` reported the required aggregate as expected despite the green rollup.
The normalized API receipts are in `scripts/__fixtures__/required-check-pr790.json`.
This establishes the failure on that revision; a green rollup alone is not a
ruleset verdict. See GitHub's [check-suite model](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks)
and [required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

After the trusted metadata gate is deployed, a body/title edit may avoid heavy
jobs only when GitHub's read-only Actions API proves a completed successful code
run for the same PR, head and base repository/ref. Selection records a compact
`CI source v1` binding in a provider-owned step name. Reuse requires the latest
code run and its current attempt's successful aggregate; metadata gates cannot
become transitive sources of code evidence. Complete pagination, source binding,
workflow identity and live PR identity are checked. The aggregate independently
rechecks evidence before reporting success, and requires every heavy job to have
skipped. Failed, unfinished, missing, unbound legacy or ambiguous evidence selects
full validation on an edit, never an optimistic green or a narrowed leaf class.
Thus an edit during unfinished code validation can cost an additional full run;
this conservative fallback avoids a long-lived polling runner or stale green gate.
An API failure or changed evidence at final recheck fails the aggregate closed.

The target binding deliberately tracks repository/ref, not the moving base tip;
ordinary base advancement retains the repository's existing up-to-date policy.
Base retargets and code updates still validate code. Existing runs without source
bindings need one fresh full validation before reuse. Stacked targets must have
the trusted metadata workflow definition, otherwise full edited-event validation
remains. No ruleset, required context, app binding, write permission or administrator
bypass changes are needed. Metadata CI does not cancel code work.

Main runs no longer hold one workflow-wide slot through tests and publication.
The selector first rejects a superseded main source. Only first-attempt main
push/schedule validation shares cancellation keys by job and partition. Manual
runs and reruns (including failed-jobs-only reruns with carried-forward selector
outputs) use run/attempt keys, so they cannot suppress current-main publication.
PR job keys are also run/attempt-specific; only code workflow concurrency cancels
obsolete PR code runs. Publication remains a non-cancelling serialized
trusted `workflow_call`, admitted only after its exact source's successful gate.
All existing source/provenance/scan/privacy/coherent-pointer guards remain.
A superseded main selection may finish without code work; its selection reason
and skipped aggregate are not evidence of successful code validation. Do not count such intermediate commits as individually validated.
GitHub orders concurrency requests by arrival rather than commit topology. A
delayed older first-attempt job can still supersede newer validation; the source
guard reduces this window but does not prove scheduler ordering. Publication's
unchanged final freshness/atomicity guards prevent stale promotion; daily full
reconciliation remains necessary. Qualify overlap on a test repository before
claiming hosted latest-source scheduling acceptance.

## Build identity and production context

`pnpm build` caches ordinary package builds and web `build:app` separately, then
runs the tiny uncached web `build:deploy` stamp/copy task. Only deployment stamping
consumes `SW_BUILD_ID`; changing it does not invalidate Next compilation or
unrelated package builds. The stamp always runs, including when local fallback
identity comes from Git, so cache restoration cannot deliver an old service-worker
identity. Direct web builds retain their behavior; their combined Turbo task is
uncached. The web Dockerfile likewise compiles before declaring the changing ID.
Integration sources outside `apps/web` are explicit inputs of cacheable Next
compilation; a real dry-graph regression proves an integration edit changes its
hash. A separate built-output test checks two deployment identities in both the
public worker and copied standalone worker, including static assets.

Root Docker contexts exclude `*.test.ts(x)`/`*.spec.ts(x)` sources. Fixture/assets
are deliberately retained. The planner applies the same ordered Docker ignore
semantics, honoring Dockerfile-specific policies and later reinclusions. Control
inputs always count, and unknown policies/symlinks retain conservative rebuilding.
Production bundle/image builds must prove no runtime reads a removed test source.
Policy commands already in `check:policy` no longer execute twice in lint.

Anonymous GHCR build-cache manifests were readable, but the local emulated cold
benchmark did not establish a net saving. Additional registry imports remain
disabled pending controlled cold/unchanged/source-edit measurements. Same-run image
reuse also remains a measured follow-up: transfer overhead is unknown, and both
independent image scans and the native ops-agent image test remain required. CodeQL keeps its
existing required producer and cancellation policy; stale manual scans must not
cancel current main's scan. No live ruleset change is part of this rollout.

## Qualification status

The November 6 investigation measured successful PR p50 13.45m before the native
recovery expansion versus 55.87m on November 5–6, and main p50 19.02m versus
61.62m including publication. Those are calendar cohorts, not controlled trials.
Local tests prove selection, complete inventory, isolated databases and build/hash
behavior; they do not prove hosted cancellation, runner capacity or latency gains.
Collect at least ten comparable normal hosted runs after rollout before claiming
p50/p90 or cost improvement. Track added setup/peak runner demand as well as gate
time: parallel shards can use more runner minutes even when feedback is faster.

## Docs validation

Matching pull requests build docs once in required CI's `build Docker (docs)` job.
The shared `docs/Dockerfile` runs `pnpm typecheck` followed by `pnpm build`, so
either TypeScript errors or site compilation errors fail the image build. This
job uses read-only permissions and does not log into a registry or publish images.

The Docker target selector retains the previous docs workflow's PR coverage:
`docs/**`, `.github/workflows/docs.yml`, `.trivyignore.yaml` and `.nvmrc`.
These inputs add docs validation without narrowing other image targets. CI runs
on every PR, and the stable `lint / types / test` aggregate rejects a failed,
cancelled or missing applicable Docker build.

The dedicated docs workflow publishes only from trusted main. It resolves current
main before checkout and builds independently through the same Dockerfile; it
does not reuse an untrusted PR artifact or wait for application publication.
Exact-digest vulnerability scans still precede alias promotion. Weekly scheduled
builds and forced refreshes retain uncached builds for fresh OS packages.

PR docs validation runs through the required Docker build job; trusted-main
publication remains separate. Use the normal-run protocol above to measure
latency or runner cost.
