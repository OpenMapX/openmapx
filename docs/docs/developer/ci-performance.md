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
