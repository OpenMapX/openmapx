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

## Dependency-layer inputs

The API and web images stage integration `package.json` files before installing
dependencies. The ops-agent and transitous-runner images do the same for workspace
packages. [`COPY --parents`](https://docs.docker.com/reference/dockerfile/#copy---parents)
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
