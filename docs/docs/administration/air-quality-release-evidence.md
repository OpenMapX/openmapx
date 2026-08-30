---
title: Air-quality release evidence
description: Performance, accessibility, compatibility, and verification evidence for the canonical release.
---

# Air-quality release evidence

This record covers the canonical base release at the repository HEAD that
contains plans 01–06 and 11. Optional providers remain independently blocked in
the [release matrix](./air-quality-release-status.md).

## Performance reference

`pnpm bench-air-quality` runs the production canonical current, forecast, and
station route handlers in process with a deterministic provider and warm
`MemoryUpstreamRuntime`. It validates every HTTP-equivalent status and enforces
the 2 MiB JSON ceiling. This is local reference evidence, not a shared-CI timing
assertion.

Recorded 30 August 2026 on Node v24.18.0 and an Apple M1 Pro:

| Workload | Samples / concurrency | p50 | p95 | max | max JSON |
| --- | --- | ---: | ---: | ---: | ---: |
| Cached current | 1,000 / 20 | 6.85 ms | 8.31 ms | 13.56 ms | 3,328 B |
| 24-hour forecast | 100 / 10 | 89.38 ms | 134.10 ms | 135.03 ms | 70,860 B |
| Station page | 100 / 10 | 6.33 ms | 7.74 ms | 7.75 ms | 1,147 B |

The release gates are cached-current p95 below 250 ms and every JSON payload at
or below 2 MiB. Both passed. The benchmark tests cover nearest-rank percentile
math, warm-up exclusion, exact concurrency, status rejection, and payload
bounds.

## Compatibility and source-policy evidence

The two compatibility handlers remain until their documented sunset:

- OpenAQ: `/api/integrations/overlay-air-quality/air-quality/stations`
- Open-Meteo: `/api/integrations/weather-open-meteo-air-quality/aqi`

Both emit `Deprecation`, `Sunset`, and canonical successor headers and increment
the closed compatibility-use metric. Repository search on 30 August 2026 found
no first-party runtime caller of either legacy path; only handlers, tests,
OpenAPI, and migration documentation remain. Source-policy exclusions are
applied before provider dispatch.

## Accessibility and resilience

Automated component suites cover semantic disclosure controls, keyboard names,
printed status alongside color, focus behavior, reduced-motion behavior, stale
and partial states, retained snapshots after failure, aborted obsolete requests,
strict-mode remounts, and lossless MapLibre style replacement. The manual pass
uses the browser accessibility tree rather than claiming a VoiceOver/NVDA run
that was not performed.

| Environment | Scenario | Result |
| --- | --- | --- |
| T3 Code Nightly 0.0.37 / Chromium 146.0.7680.216, macOS | Keyboard-only shell traversal and semantic names; 640×400 and 320×240 CSS viewports representing the reflow space available at 200% and 400% from 1280 px; dark scheme; API/map-style unavailable | Pass: controls remained keyboard reachable and named, both constrained viewports had no document-level horizontal overflow, dark colours applied, and the unavailable API/style produced a bounded degraded shell instead of a crash. The local API correctly refused startup because the checkout had no migrated database, so this run does not claim live-provider rendering. |
| Chromium accessibility tree plus focused Vitest/jsdom component suites | Place disclosure names/status, non-colour status text, monitor legend, reduced motion, stale/partial/unavailable, slow/aborted requests, provider failure, retained snapshot, and style reload | Pass: browser semantics were exposed for the reachable shell; the air-quality-specific states passed their deterministic component suites. This is semantic-tree inspection, not a claim that VoiceOver or NVDA was run. |

Forced-colour and reduced-motion media behavior is asserted in the focused UI
suites because the collaborative browser exposes colour-scheme emulation but
not those two media-feature emulations. This limitation is explicit evidence,
not a substituted manual claim.

## Verification log

The final command, duration, exit code, date, and exact HEAD are appended here
only after the complete closeout command sequence has actually run.
