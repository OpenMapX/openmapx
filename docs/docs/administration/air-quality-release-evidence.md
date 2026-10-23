---
title: Air-quality release evidence
description: Performance, accessibility, compatibility, and verification evidence for the canonical release.
---

# Air-quality release evidence

This is saved evidence from the canonical base release, verified on 30 August
2026 at `337bd463`. It is not a fresh run against the current checkout, current
upstream services or a production deployment. Optional providers have independent
[release status](./air-quality-release-status.md); a blocked provider remains
blocked until its own evidence requirements are met.

## Performance reference

`pnpm bench-air-quality` runs the production canonical current, forecast, and
station route handlers in process with a deterministic provider and warm
`MemoryUpstreamRuntime`. It validates every HTTP-equivalent status and enforces
the 2 MiB JSON ceiling. This is local reference evidence, not a shared-CI timing
assertion.

Recorded 30 August 2026 on Node v24.18.0 and an Apple M1 Pro:

| Workload         | Samples / concurrency |      p50 |       p95 |       max | max JSON |
| ---------------- | --------------------- | -------: | --------: | --------: | -------: |
| Cached current   | 1,000 / 20            |  6.85 ms |   8.31 ms |  13.56 ms |  3,328 B |
| 24-hour forecast | 100 / 10              | 89.38 ms | 134.10 ms | 135.03 ms | 70,860 B |
| Station page     | 100 / 10              |  6.33 ms |   7.74 ms |   7.75 ms |  1,147 B |

At that checkpoint, the cached-current p95 gate below 250 ms and JSON ceiling of 2 MiB both passed. The benchmark tests cover nearest-rank percentile
math, warm-up exclusion, exact concurrency, status rejection, and payload
bounds.

## Compatibility and source-policy evidence

The checkpoint included these compatibility handlers, with their documented sunset headers:

- OpenAQ: `/api/integrations/overlay-air-quality/air-quality/stations`
- Open-Meteo: `/api/integrations/weather-open-meteo-air-quality/aqi`

Both emit `Deprecation`, `Sunset`, and canonical successor headers and increment
the closed compatibility-use metric. Repository search on 30 August 2026 found
no first-party runtime caller of either legacy path; only handlers, tests,
OpenAPI, and migration documentation remain. Source-policy exclusions are
applied before provider dispatch.

## Accessibility and resilience

The recorded automated component suites covered semantic disclosure controls, keyboard names,
printed status alongside color, focus behavior, reduced-motion behavior, stale
and partial states, retained snapshots after failure, aborted obsolete requests,
strict-mode remounts, and lossless MapLibre style replacement. The recorded manual pass
used the browser accessibility tree rather than claiming a VoiceOver/NVDA run
that was not performed.

| Environment                                                            | Scenario                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3 Code Nightly 0.0.37 / Chromium 146.0.7680.216, macOS                | Keyboard-only shell traversal and semantic names; 640×400 and 320×240 CSS viewports representing the reflow space available at 200% and 400% from 1280 px; dark scheme; API/map-style unavailable | Pass: controls remained keyboard reachable and named, both constrained viewports had no document-level horizontal overflow, dark colours applied, and the unavailable API/style produced a bounded degraded shell instead of a crash. The local API correctly refused startup because the checkout had no migrated database, so this run does not claim live-provider rendering. |
| Chromium accessibility tree plus focused Vitest/jsdom component suites | Place disclosure names/status, non-colour status text, monitor legend, reduced motion, stale/partial/unavailable, slow/aborted requests, provider failure, retained snapshot, and style reload    | Pass: browser semantics were exposed for the reachable shell; the air-quality-specific states passed their deterministic component suites. This is semantic-tree inspection, not a claim that VoiceOver or NVDA was run.                                                                                                                                                         |

At that checkpoint, forced-colour and reduced-motion media behavior was asserted in the focused UI
suites because the collaborative browser exposes colour-scheme emulation but
not those two media-feature emulations. No manual forced-colour/reduced-motion or screen-reader run was established.

## Verification log

The implementation was verified on 30 August 2026 at code revision
`337bd463` (`feat(air-quality): close release evidence and provider gates`).
This evidence record is the documentation-only follow-up to that revision.

| Command                          |            Duration | Exit | Result                                                                                       |
| -------------------------------- | ------------------: | ---: | -------------------------------------------------------------------------------------------- |
| Focused air-quality Vitest suite |        Not recorded |    0 | 41 files and 308 tests passed                                                                |
| Closeout-focused Vitest suite    |        Not recorded |    0 | 8 files and 74 tests passed                                                                  |
| Policy-contract Vitest suite     |        Not recorded |    0 | 4 files and 37 tests passed                                                                  |
| `pnpm test`                      | 187.34 s wall clock |    0 | 1,240 files passed, 10 skipped; 13,495 tests passed, 50 skipped                              |
| `pnpm check-types`               |             36.05 s |    0 | 29 tasks passed across 133 workspaces                                                        |
| `pnpm lint`                      |             14.62 s |    0 | Passed; 20 existing Biome warnings and 216 existing translation warnings remain non-blocking |
| `pnpm check:policy`              |             16.46 s |    0 | All policy checks passed, including the air-quality release gates                            |
| Translation checks               |              6.09 s |    0 | Passed with the existing non-blocking warnings                                               |
| OpenAPI checks                   |              5.81 s |    0 | Passed for 315 operations                                                                    |
| `pnpm check-dead-code`           |        Not recorded |    0 | Passed                                                                                       |
| Documentation typecheck          |              1.54 s |    0 | Passed                                                                                       |
| Documentation production build   |              4.99 s |    0 | Passed                                                                                       |
| `git diff --check`               |        Not recorded |    0 | Passed                                                                                       |

The exact root `pnpm build` built the API, data manager, operations agent,
extension CLI, and transit runner, then failed in the web Turbopack PostCSS
worker because the execution environment denied binding its local IPC port
with `EPERM`. Re-running with elevated sandbox permissions produced the same
environmental failure. No production code was changed to hide it. The
supported `pnpm -C apps/web exec next build --webpack` fallback completed in
10.2 minutes, including TypeScript validation, all 30 static pages, and output
tracing. `pnpm -C apps/web build:sw` and
`pnpm -C apps/web build:copy-assets` also passed.
