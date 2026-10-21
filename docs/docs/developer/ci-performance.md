# Measuring CI performance

Keep the required `lint / types / test` context and its full validation coverage
while optimizing CI. Measure queue delay, execution time and summed runner time
separately. A faster cache export can still make the next build slower.

## API cache export policy

API validation and trusted image builds export the minimal cache (`mode=min`).
They keep the existing `api` scope and cache imports. Other image targets retain
`mode=max`; the comparison measured the API only. Release provenance, SBOMs,
scans and the full required validation gate remain in place. The release planner
still cold-builds an image when its last cold refresh is at least seven days old.

The [qualification run](https://github.com/OpenMapX/openmapx/actions/runs/39052091932)
completed nine builds at revision `c710f887e0e89085018e4e3b10a78a1ed89d570d`.
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
`ignore-error=true`: a cache failure means a cold build, never a failed release.
PR validation builds keep their PR-scoped Actions cache because PR jobs hold no
registry credentials. See the [registry cache backend](https://docs.docker.com/build/cache/backends/registry/).

## Dependency-layer inputs

The API and web images stage integration `package.json` files before installing
dependencies. The ops-agent and transitous-runner images stage only the manifests
of the workspace packages they use, so `node_modules` holds only their dependencies.
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
- ops-agent copies the 12 packages its code and fixed CLI reach, plus the three
  data-manager modules the CLI imports. transitous-runner copies its 7 packages,
  and the data-manager builder copies its 14. These images no longer copy all
  of `packages/` or `services/`.
- The lockfile counts only for what an image installs: the importers whose
  `package.json` it copies, the workspace importers they link, and every
  snapshot and package reachable from them, plus the lockfile settings. If the
  planner cannot follow an entry, it counts the whole file. The plan job installs
  the workspace for the `yaml` parser.
- `ci.yml` is not an input: it passes nothing to `docker.yml`.

`check-dockerfile-workspace-sync` keeps the narrowed images complete. It walks
the TypeScript import graph from each tsx image's entry points with that image's
module resolution. Every repository file reached must be copied into the runner.
A computed dynamic import must declare the files it loads.

Over the 200 main commits before this change, the same planner rules would have
rebuilt ops-agent 106 times instead of 139, transitous-runner 97 instead of 121,
data-manager 118 instead of 130, transitous-tools 10 instead of 18, and
privacy-backup 8 instead of 17. API and web include every integration and change
in most commits anyway. Most remaining rebuilds come from `packages/core`: every
image uses it, and ops-agent's CLI imports its barrel, which reaches about 1,000
of its files. File-level inputs would mostly help transitous-runner, which reaches
3 core files. They are not used, because computed imports and file reads cannot
all be followed, and a missed one would let a release reuse an image with stale code.

## Runtime bundles

Images that ran workspace TypeScript under tsx are moving to runtime bundles,
starting with transitous-runner. `scripts/build-runtime-bundles.mjs` bundles an
image's own code and the workspace code it reaches with esbuild:

- npm packages stay installed in the image, but every import is pinned. The script
  resolves it from the importing package's location, as Node does in the pnpm
  layout, and rewrites it to a path relative to the output directory. The bundle
  therefore loads the same dependency files as before.
- A literal `new URL("…", import.meta.url)` asset is copied into `dist/assets/`.
- A computed `import()`, any other use of the module's own location, and any
  esbuild warning fail the build.
- The output is byte-identical across builds and checkout locations.

The release planner fingerprints a bundled image by its bundle digest instead of
by the stages that only feed the `bundle` stage. The production install counts
through what it reads: the install fields of each manifest and the production
lockfile entries. Scripts, versions and development dependencies do not count.
The plan job builds the bundles. A release build passes the planned digest as
`EXPECTED_BUNDLE_DIGEST`, and the `bundle` stage fails when its bundle differs.
The runner checks that every pinned dependency file exists in its production
install. `check-dockerfile-workspace-sync` builds every bundle and rejects a
bundled runner that copies workspace source.

Over the 200 main commits before this change, bundles would have rebuilt
transitous-runner 24 times instead of 97 (its bundle never changed; the rest are
Dockerfile, workflow and dependency changes). For ops-agent and data-manager the
same replay gives 57 and 58 instead of 106 and 118.

Changesets excludes package-root `Dockerfile` edits from release detection;
these private deployment-image changes do not need empty package notes. Source,
package manifests and nested Dockerfile fixtures still participate in the gate.
The wider package/release baseline is handled separately.

## Database groups

Database validation runs in three jobs on separate GitHub-hosted runners:

| Group            | Coverage                                                                         | Additional prerequisites                                |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `api-privacy`    | Authentication, API routes, privacy lifecycle, core database and migration tests | Migrated PostGIS                                        |
| `ingestion`      | Data-manager accounting, search, Overture and ambient publication                | Test-owned PostGIS containers                           |
| `export-restore` | Controller-wide export and backup restore replay                                 | Exact-image Dawarich export and retained-backup archive |

Each runner gets the same pinned PostgreSQL 18 / PostGIS 3.6 service and applies
all production migrations. Testcontainers, Compose fixtures and archive paths are
owned by that runner. No database or archive is shared between jobs. Within each
group Vitest uses one worker; increasing that can corrupt shared fixture state.

The matrix does not cancel other groups when one fails. The required
`lint / types / test` aggregate still requires the database matrix to succeed;
a failure, cancellation or skipped database job cannot pass it. The three privacy
fixture steps run only in `export-restore`, where the archive is consumed directly
by controller-wide export. Missing or empty archive input is an error, rather than
a switch to the synthetic fixture.

Run `pnpm test:database <group>` locally, or omit the group to run the full union
serially. See [Contributing](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#testing)
for disposable-database setup and archive preparation. The checked-in inventory
is validated against discovered opt-in tests and actual Vitest file selection.
Dawarich's exact-image test remains a separate explicit command in the export job.

This removes serialization between the groups and repeats runner setup three
times. Compare normal-run gate time, queue delay and summed runner seconds before
claiming an overall improvement. Local correctness checks do not establish CI
latency or cost; the ten-run comparison remains required.

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

This removes a duplicate PR validation job. It does not establish an overall
latency or runner-cost improvement; compare at least ten comparable normal runs
before making that claim.
