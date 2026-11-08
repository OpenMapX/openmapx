# Shared travel plans: revised implementation plan

> Use superpowers:executing-plans. Root agent implements; Claude Opus reviews.
> The user clarified normal provider-trip selection with essentially no new UI.
> This replaces the previous fixed-import plan.

**Spec:** `docs/superpowers/specs/2026-11-06-shared-travel-plans-design.md`

## 1. Review the revised design

- [x] Reassess the user's clarification against the existing implementation.
- [x] Inspect pinned MOTIS structured reconstruction and ordinary query/selection paths.
- [x] Self-review this spec/plan and obtain Claude Opus design review.
- [x] Resolve review findings before implementation; use distinct reference queries for reconstruction (B1).

## 2. Return normal provider itineraries

Keep parsing/native preservation and identity matching. Replace composition in
`packages/core/src/travel-plans/{resolve,apiPort}.ts` with normal-plan exact matching
and a source-neutral provider reconstruction fallback.

- [x] Add failing tests that require untouched complete provider plans and exact selected identity.
- [x] Add normal planning, one discovery page/re-anchor, optional service-mode retry and whole-sequence exact matching. Seed only unpaged results.
- [x] Define bounded typed provider trip references and optional `resolveTrip` capability.
- [x] Add validated `POST /plan/resolve`, orchestration and MOTIS local/hosted adapters.
- [x] Use native structured refresh, raw response validation, honest hosted feature detection and source policy. Reference refresh may never replan to another trip.
- [x] Add negative tests for substitutions, merged/dummy legs, invalid transfers and unsupported sources.
- [x] Regenerate OpenAPI, inspect diff and update developer documentation.

## 3. Reuse normal directions state and UI

- [x] Remove import summary/banner/alternatives strings and components, composed geometry and permanent imported mode.
- [x] Share canonical normal request/key construction and capabilities options. Add a distinct provider-reference query variant, not a fake search cache entry.
- [x] Lift transit time mode into the store, move stable itinerary identity to core and add the one-shot raw/debounced-key selection handoff.
- [x] Seed the complete provider envelope under its truthful query key and atomically publish matching route inputs/selection. Preserve wheelchair/mandatory requirements and persisted hill preference.
- [x] Open ordinary details after matching-key publication and ranking. Keep existing normal refetch behavior; reference refetch re-resolves the same trip, without paging.
- [x] Test mounted-panel/debounce/stale-query/capability and geolocation races.
- [x] Open recognized travel plans automatically; preserve authority/acknowledgement checks, file confirmation and generic error/retry feedback.

## 4. Verify and review

- [x] Run focused parser/provider/store/hook/intake tests and affected types.
- [x] Inspect ordinary details with intentionally different provider data and production theme.
- [x] Verify real SDK serialization and negative native contracts with synthetic HTTP fixtures. Resolve all four examples against live Transitous MOTIS 2.11.4 in an adapter/resolver harness (one normal search, three native reconstructions); this is not native share-sheet or deployed-instance qualification.
- [x] Obtain Claude Opus revised implementation review; fix supported findings and verify.
- [x] Run full local gates and relevant mobile/Swift/bundle/docs checks. Report any unrelated failures accurately.

## 5. Deliver

- [x] Replace obsolete visual evidence with actual normal directions behavior and inspect it.
- [x] Commit the verified work locally. The user has now authorized publication after rebasing onto latest `origin/main`.
- [ ] Create and immediately link the authorized PR, assign Medformatik, use
      an existing appropriate label, and inspect hosted visual evidence and metadata.

The old portable run was stopped after the user's clarification; it is not final
verification of this design. Existing build-artifact timeout failures are tracked
in the local ledger; do not weaken those tests or silently call the old run green.

## Final verification

- Full gates: lint, 32 workspace type checks, policy and generated OpenAPI/SDK
  freshness passed. The bounded portable run completed with 26,997 passed,
  three failed and 787 skipped tests.
- The new route required the inventory assertion to advance to 423 paths and
  455 operations; corrected and rerun successfully. The other two failures were
  deadlines in unchanged artifact-leasing code. Both affected files passed all
  20 tests together with one worker and their original deadlines. The failing
  artifact test's 129 tracked bundled inputs and lockfile are unchanged from base.
- Focused sharing/UI checks pass; all 17 provider test files pass (159 tests),
  including the final SDK-to-host-HTTP transport contract. Final core and API
  integration type checks pass after the small export/transport adjustments.
- Mobile: 83 suites / 1,416 tests. Swift intake: 24 tests. Headless bundle and docs
  production build pass. The production-themed rendered states were inspected.
- Live provider verification resolved all four examples against Transitous in
  an adapter/resolver harness. Native share-sheet delivery, a deployed OpenMapX
  API and local-MOTIS-plus-hosted-fallback runtime were not exercised. No database
  changes. Publication was initially deferred; the user subsequently authorized
  rebasing onto latest `origin/main` and opening the PR.

## Rebase verification

The feature was rebased without conflicts onto `3e63c602d`, which includes merged
PRs #788 and #791. All six feature commits have identical patches in `range-diff`.
The rebased tree passes 1,605 tests across 110 affected test files, all 32 workspace
type checks, discovery-eval types, lint, policy and OpenAPI/SDK freshness checks.
The mobile suite passes 83 suites / 1,416 tests; Swift intake passes 24 tests;
the headless bundle check and docs production build also pass. Rendered screenshots
were refreshed with the production theme and the newer provider delay display.
The earlier broad-suite result remains recorded above; unrelated artifact tests
were not repeated after this rebase, as requested by the user.
