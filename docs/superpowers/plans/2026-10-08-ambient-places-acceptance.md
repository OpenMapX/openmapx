# Ambient Place Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining #399 acceptance gaps in PR #436.
**Architecture:** Keep the existing immutable publication and overlay contracts.
Correct actual extractor category compatibility, add conservative auditable landmark
ranking and repair per-layer filter lifecycle. Verify with a real cropped regional
index and production-asset desktop/mobile QA.
**Tech Stack:** TypeScript, React/Next, MapLibre, PostGIS, Osmium, T3 preview/device.
**Spec:** docs/superpowers/specs/2026-10-08-ambient-places-acceptance-design.md

## Global Constraints

- One Rhine bbox [6.58,50.89,7.07,51.31]; all existing hard publication/read budgets.
- Policy version 2; essential z13, designated/high heritage landmarks z14,
  other supported registered landmarks/businesses z15, other places z16, tenants z18.
- No OpenConditions/adapters/feeds/mobility changes, planet/direct ATP ingestion,
  geocoder redesign, offline delivery, merge or deployment.
- Existing feature worktree and PR #436; no checkpoint approvals; external screenshots.
- Build <=60s; warm tile p95 <=100ms, concurrent-eight p95 <=250ms, first <=1000ms.
- Five foreground 5s sweeps/state; frame p95 <=33.4ms, >50ms <=5%; do not loosen targets.

## Review Focus

- Extracted slash-category rows receive the same tiers as colon aliases: Task 1.
- Ordinary/malformed/closed/private/tenant cultural features never gain unjustified
  early prominence: Task 1.
- Identical filter keys after paint-only recreation still reinstall suppression:
  Task 2.
- Real source geometries, exact IDs and publication provenance survive extraction
  and canonical place selection: Task 3.
- Dense real-data scenes retain road/transit priority and meet declared read/frame
  budgets with source/collision failures separated: Task 3.

### Task 1: Source-compatible landmark policy and corpus

**Files:** Modify `packages/core/src/ambient-places.ts`,
`packages/core/src/ambient-places.test.ts`; create
`services/data-manager/__tests__/ambient-places/extractor-policy.test.ts` and
`services/data-manager/__tests__/ambient-places/landmark-corpus.json`;
modify `apps/web/src/components/admin/services/AmbientPlacesMaintenance.tsx` and
its existing test; update `.changeset/quiet-ambient-places.md`.
**Interfaces:** consumes existing `featureToSearchPlace`/`AmbientOsmRow`;
produces policy version 2 and unchanged `AmbientPlace`/MVT properties.

- [ ] Add extractor-to-policy regressions for `amenity/hospital`, `shop/bakery`,
  real landmark corpus and ordinary/private/closed/tenant/invalid evidence controls.
  Assert hospital z13, bakery z15, designated landmarks z14, ordinary worship z16,
  non-ground z18, no false early tiers and identical colon/slash categories.
- [ ] Run `pnpm exec vitest run packages/core/src/ambient-places.test.ts services/data-manager/__tests__/ambient-places/extractor-policy.test.ts`.
  Expected: new ranking/actual extractor tests fail on current code.
- [ ] Normalize slash/colon categories; implement source-backed landmark tier in
  shared policy, bump policy version, expose current version in admin metadata
  and cover it in the existing admin test. Retain all identity/closure guards.
- [ ] Run the above plus admin component test and real publication suite.
  Expected: all pass; decoded exact IDs and feature/byte budgets still pass.
- [ ] Commit `fix(places): rank source-backed regional landmarks`.

### Task 2: Resilient suppression on theme layer recreation

**Files:** Modify `integrations/overlay-ambient-places/map-layer.tsx` and
`integrations/overlay-ambient-places/map-layer.test.tsx`.
**Interfaces:** consumes existing group hook and MapLibre filters; no shared hook
or other overlay behavior changes.

- [ ] Add a theme rerender regression: a selected/owned canonical feature is
  suppressed, real descriptor recreation drops the imperative label filter, the
  full basemap reload never arrives, and idle must restore it. Assert no repeated
  writes on subsequent unchanged idles, normal style reload and teardown.
- [ ] Run `pnpm exec vitest run integrations/overlay-ambient-places/map-layer.test.tsx`.
  Expected: recreation regression fails before the fix.
- [ ] Repair filter/layer cache comparison and theme effect lifecycle, keeping
  scoped identities, data-load handling and stable event cleanup.
- [ ] Repeat the file plus existing identity/tap and group-hook tests.
  Expected: all pass with no shared hook changes.
- [ ] Commit `fix(web): retain ambient suppression across theme changes`.

### Task 3: Real regional publication and controlled acceptance evidence

**Files:** Update existing developer ambient/baseline docs; create
`docs/docs/developer/ambient-places-acceptance.json` (aggregate public evidence,
no images/source binaries/private URLs). Temporary QA servers/pages/scripts,
PBFs, metrics and captures remain under `/tmp/openmapx-399-acceptance` or ignored.
**Interfaces:** consumes unchanged extractor/index and publication/tiles; produces
checksummed source/QA evidence and passing targets from the spec.

- [ ] Acquire dated metadata-stripped source PBFs, record SHA/timestamp, crop the
  one region and build via existing extract/index into disposable PostGIS.
  Expected: ready real OSM index with source-backed landmark rows; no production writes.
- [ ] Publish and measure at least 30 sparse/dense reads plus eight concurrent
  requests; decode limits, check old bytes, failure fallback and rollback on the
  same source. Expected: spec payload/publication/query targets pass.
- [ ] Build and serve production web assets through a temporary fixture route
  mounting the real overlay, basemap, attribution and place-card components.
  Repeat #393 cameras/zooms, real Neuss/Cologne/rural scenes, theme/locale/provider
  configuration, identity taps and no-region controls. Expected: landmarks visible
  at intended zooms, no explicit duplicates, road/transit priority preserved.
- [ ] Use T3 preview plus available iOS Safari simulator; run five foreground 5s
  sweeps per state and record raw/aggregate frame data. Expected: declared frame
  targets pass; exact device/runtime limits disclosed.
- [ ] View selected actual before/after/mobile images; record screenshot checksums
  externally. Update aggregate evidence/docs and remove temporary QA product files.
  Expected: reproducible source/settings/metrics, no screenshots in git.
- [ ] Run focused policy/overlay tests and real PostGIS publication/admission tests.
  Expected: all pass. Commit `docs(places): verify real regional acceptance budgets`.

### Task 4: Final review, gates and updated PR

**Files:** Existing PR body/screenshots outside repository; relevant current docs.
**Interfaces:** consumes Tasks 1–3, delivers accurate complete PR #436 evidence.

- [ ] Self-check every current #399 criterion and comment against evidence.
  Expected: no code or regional QA criterion falsely claimed complete.
- [ ] Run root lint/types/full test (four workers), web/API/data-manager/docs
  builds and real PostGIS task suite. Expected: all pass; failed targets are fixed.
- [ ] Dispatch one fresh strongest-model whole-branch reviewer with spec/plan,
  issue text/comment and evidence, then fix important findings with RED→GREEN
  tests and a green suite. Expected: no unresolved important findings.
- [ ] Commit, push with temporary HTTPS credentials and update PR #436 with real
  evidence attachments. Immediately T3-link; verify head/assignee/existing labels,
  uploaded image hashes and thread PR list. No merge/deploy.
- [ ] Run final real PostGIS completion suite. Expected: pass; copy decisions and
  delete only this plan's ignored workspace; hand back with limitations accurately stated.

## Plan self-review

Each of the four previously disclosed gaps has an owning task. Actual source
category compatibility is tested at the extractor boundary. Ranking changes
neither geocoder retrieval nor ingestion contracts. All real data writes target a
disposable database, and both sides of each visual comparison use the same source
and publication. Physical-device thermal/battery certification is a disclosed
rollout limit, not a fabricated simulator result. User authorization overrides
skill checkpoint gates and preserves inline execution.
