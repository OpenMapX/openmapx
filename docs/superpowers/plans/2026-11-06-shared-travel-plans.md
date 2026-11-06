# Shared Travel Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the verified train sequence in a German DB Navigator share through an extensible source-adapter pipeline.

**Architecture:** Pure shared parsers normalize explicit travel plans. A bounded resolver verifies each leg against enabled OpenMapX providers; atomic fixed-trip publication reuses existing directions UI, map and navigation.

**Tech Stack:** TypeScript, Vitest, Zustand, React/MUI, existing OpenMapX transit API. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-shared-travel-plans-design.md`

## Global Constraints

- No automatic navigation start, new upstream, API route, native protocol or raw-share persistence.
- Existing 4096-character/8192-byte limits; at most 8 legs and 72 hours.
- Exact train number, station names and scheduled times; unavailable/ambiguous fails closed.
- Europe/Berlin domestic times; reject DST gaps/folds and cross-timezone endpoints.
- Maximum 4 stop records and 4 journey candidates per leg, 60-second deadline.
- No network before Open; repeat authority checks after resolution before publication.

## Review Focus

- A second malformed/truncated train block must invalidate the whole share.
- Realtime fields must not turn a changed scheduled train into a match.
- Duplicate provider station/trip records must not hide geographic or trip ambiguity.
- Responses after draft/item/route/authority changes must never publish.
- Closing/editing/replanning an imported trip must release its fixed state.

### Task 1: Source-neutral model and DB adapter

**Files:** create `packages/core/src/travel-plans/{types,dbNavigator,index}.ts` and co-located tests/fixtures; modify `packages/core/src/navigation/nativeIntake.ts` and its tests/export surface.

**Interfaces:** `parseSharedTravelPlan(text)` returns unrecognized, invalid or plan; `SharedTravelPlan` carries source and ordered explicit legs. `classifySharedText` returns a travel-plan intent before generic multiline handling.

- [ ] Add all four fixtures, parser tests and recognized-invalid/malformed/size/date/overnight tests; run and observe failure.
- [ ] Implement bounded adapter registry and strict complete DB parser.
- [ ] Verify parsers and existing map-intake regressions; commit.

### Task 2: Exact resolver and API port

**Files:** create `packages/core/src/travel-plans/{resolve,apiPort}.ts` and tests; use existing `api/transit.ts`, `api/client.ts` and timezone helpers.

**Interfaces:** `resolveSharedTravelPlan(plan, port, signal): Promise<TripItinerary>`; port searches stops, anchored departures, vehicle journeys and segment geometry with signal; typed errors map to user outcomes.

- [ ] Write failing fixture-backed resolver tests for each supplied journey, wrong/missing train numbers, scheduled time conflicts, anchored departure lookup, duplicate versus ambiguous identities, timezone/DST, cancellation and budget limits.
- [ ] Implement exact station resolution, bounded sequential departure/journey resolution and unique candidate verification, conservative itinerary composition and contributor preservation.
- [ ] Verify tests, core types and no headless network-barrel regression; commit.

### Task 3: Atomic fixed-trip state and presentation

**Files:** modify `packages/core/src/stores/directionsStore.ts`, tests, `apps/web/src/components/panels/directions/{useTransitDirectionsPlan,DirectionsPanelContent}.tsx/ts`, tests and locale JSON.

**Interfaces:** `openImportedTransitTrip(itinerary, sourceLabel)` atomically sets fixed trip state; routing edits/close and an explicit alternatives action clear it. Planning hooks neither acquire nor publish while fixed.

- [ ] Write failing store/hook tests for publication, stale planning and release on edits/close/alternatives.
- [ ] Implement fixed marker/action, disabled planning and detail presentation with source/transfer notice.
- [ ] Verify ordinary planning and map layer regressions; commit.

### Task 4: Intake confirmation, cancellation and errors

**Files:** modify `apps/web/src/components/pwa/NativeIntakeHandler.tsx`, tests; create focused summary/acquisition helpers if needed; en/de locale files.

**Interfaces:** classify draft without acquiring; Open resolves with AbortSignal, then rechecks inbox/authority and synchronously opens the imported trip; complete only after publication.

- [ ] Write failing tests for preview, no early network, success/acknowledgement, retained failures, changed draft/item/lifetime and native authority races.
- [ ] Implement summary, user errors, lifecycle fencing and existing map/file compatibility.
- [ ] Run focused web/core/mobile suites and affected types; commit.

### Task 5: Review, visual evidence and PR

- [ ] Self-review against every acceptance criterion and update developer documentation with extension instructions and limitations.
- [ ] Request Claude Opus whole-implementation review; fix supported findings and rerun relevant checks.
- [ ] Run `pnpm verify:full` and relevant mobile checks, recording exact failures/remaining platform gaps.
- [ ] Capture and inspect real rendered narrow-viewport intake/details/error states; upload and inspect hosted images.
- [ ] Commit verified changes, push branch and create concise PR with Medformatik assignment and suitable existing labels; immediately link the PR to this thread.

## Reviewed additions

Task 1 also changes `apps/mobile/modules/openmapx-intake/ios/ShareSelection.swift`
and Swift tests to preserve repeated/blank lines within each text value. Header
is optional; date has explicit year. All supplied examples become committed fixtures.

Task 2 first adds `getDeparturesAt` to the transit provider contract, routes
optional validated `time` through `integrations/transit/{index,orchestrator}.ts`
and the MOTIS local/cloud adapters to stoptimes. Add route cache/validation,
orchestrator fail-closed and adapter query tests before implementing; regenerate
OpenAPI and inspect diff. No planner-only discovery: overtaken/cancelled trains
must be discoverable from departures and confirmed by the journey's stop sequence.
Geometry fallback must be labeled schematic; station clusters use 1 km and name
normalization retains locality qualifiers. Update stale paging-specific test
items to the corresponding anchored departure/candidate-bound contract.
