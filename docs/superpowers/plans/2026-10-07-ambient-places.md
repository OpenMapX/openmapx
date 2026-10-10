# Regional Ambient Places Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver #399 as a bounded, reversible regional ambient-place overlay with shared place identities.

**Architecture:** Dedicated immutable PostGIS generations separate source updates from map reads. Data-manager publishes atomically; API serves bounded MVT and admin proxy operations. A built-in overlay owns rendering, attribution and conservative duplicate suppression.

**Tech Stack:** TypeScript, postgres.js/PostGIS 3.6, Fastify 5, React 19, Next 16, MapLibre, Vitest, existing MUI admin patterns.

**Spec:** `docs/superpowers/specs/2026-10-07-ambient-places-design.md`

## Global Constraints

- Work only in the attached isolated worktree; feature PR, no merge/deploy or approval checkpoints.
- No OpenConditions, adapters, feeds, mobility contracts, planet imports, direct ATP ingestion or geocoder rewrite.
- One bbox in `[5.8,47.2,15.1,55.1]`, width/height ≤0.5 degrees; initial Aachen `[5.9,50.65,6.3,50.95]`.
- At most 100,000 input rows per source and output places; 500-row writes; eight generations; seven-day cache lease; 90-day maximum source age.
- MVT zoom 13–18; 256 features, 128 KiB, 2-second SQL timeout, eight concurrent requests per API process.
- Keep IDs as strings; confidence ≥0.5 and known-open Overture; tenants zoom 18; labels ≤120 characters; basemap proximity match ≤8 metres and unique.
- Update existing docs and admin; screenshot assets outside repo; PR assigned Medformatik with existing appropriate labels, immediately linked in T3.

## Review Focus

- Large OSM bigint IDs stay exact across SQL, tile, tap and category/search identity (Task 1/2).
- Missing or rebuilding Overture cannot silently publish a mismatched partial generation (Task 2).
- Failed/concurrent publication and retention pressure preserve active/previous and old tile URLs (Task 2).
- Ambiguous same-name branches and non-ground tenants never inherit an incorrect basemap identity (Task 4).
- Late manifest responses, disable and style replacement never resurrect layers or stale canonical mappings (Task 4).

---

### Task 1: Shared publication policy and canonical identity

**Files:** Create `packages/core/src/ambient-places.ts`, `packages/core/src/ambient-places.test.ts`; modify `packages/core/package.json`; modify `integrations/poi-overture/index.ts` and provider tests; create a changeset.

**Interfaces:** Produces `AmbientManifest`, `AmbientPlace`, `AmbientRegion`, `validateAmbientRegion(value)`, `ambientPlaceFromOsm(row)`, `ambientPlaceFromOverture(row)`, `mergeAmbientPlaces(osm, overture, links)`, `ambientPlaceToCategoryPlace(feature, locale)`, `matchAmbientBasemap(places, labels)` and `ambientIdentityKeys(place)` in `@openmapx/core/ambient-places`. Labels expose canonical IDs and GERS; shared matching uses 8m unique compatible-name rules.

- [ ] Write behavior tests for Aachen/invalid bounds, 120-character localized fallback, closure/confidence rules, importance tiers, tenants, exact `osm:node/9007199254740993`, accepted-link fusion and ambiguous duplicate matching. Assert search-provider linked Overture returns OSM ID and retains GERS.
- [ ] Run `pnpm exec vitest run packages/core/src/ambient-places.test.ts integrations/poi-overture/__tests__/provider.test.ts`; expected: failing new policy/identity tests.
- [ ] Implement shared pure contract/policy and export subpath; change only Overture POI identity SQL to use accepted links to extant OSM records. No geocoder changes.
- [ ] Run the same command; expected: all pass. Add changeset for the new core subpath.
- [ ] Commit `feat(places): define regional ambient policy and canonical identity`.

### Task 2: Atomic bounded PostGIS publisher and MVT repository

**Files:** Create `packages/core/src/server/ambient-places.ts` and export `@openmapx/core/ambient-places-server`; create `services/data-manager/src/jobs/ambient-places/{schema,build,api}.ts`; modify `services/data-manager/src/api.ts`; create `services/data-manager/__tests__/ambient-places/publish-postgres.test.ts`.

**Interfaces:** Consumes Task 1 contracts. Produces `readAmbientManifest(sql)`, `readAmbientTile(sql, generation,z,x,y)`, `buildAmbientPlaces(sql, region)`, `setAmbientEnabled(sql, enabled)`, `rollbackAmbientPlaces(sql)`, `registerAmbientPlacesApi(app, sql)`. SQL schema owns immutable generation/feature tables and singleton pointer. `GET /ambient-places/status`, `POST /ambient-places/build`, `POST /ambient-places/enabled`, `POST /ambient-places/rollback` are protected by existing data-manager auth.

- [ ] Write real PostGIS tests with OSM/Overture fixtures for bounds, links, exact bigint, ranking cap, tile content, OSM-only metadata, unfinished/old source refusal, build failure preservation, old-generation byte equality, rollback, concurrent publishers and retention lease.
- [ ] Run `OPENMAPX_RUN_DATABASE_TESTS=1 pnpm exec vitest run services/data-manager/__tests__/ambient-places/publish-postgres.test.ts`; expected: new repository/publisher tests fail before implementation.
- [ ] Implement lazy schema setup under advisory lock, repeatable-read publisher, input/output limits, generation pruning, candidate validation and atomic pointer. Reuse existing source schemas; isolate all new tables. Serve deterministic indexed MVT with safe integer XYZ and statement timeout. Register authenticated asynchronous build/status controls.
- [ ] Run the same command; expected: all pass, real MVT round trips. Record dense/sparse/repeated tile and build timings in a temporary benchmark output for Task 5.
- [ ] Commit `feat(places): publish immutable regional MVT generations`.

### Task 3: Public serving and authenticated operator API

**Files:** Create `apps/api/src/routes/ambient-places.ts` and `apps/api/src/routes/ambient-places.test.ts`; modify `apps/api/src/routes/index.ts`, generated `apps/api/openapi.json`.

**Interfaces:** Consumes Task 2 repository. Produces public manifest/tile routes and `/api/admin/ambient-places/{status,build,enabled,rollback}` proxy. Route factory injectable SQL/read/proxy seams follow existing Fastify tests. Admin requests use `requireAdmin`; mutation audit and validated data-manager origin.

- [ ] Write API injection tests for absent manifest, invalid UUID/XYZ/region, immutable/no-store cache, over-byte/concurrency limits, tile SQL failure and public rejection of admin actions.
- [ ] Run `pnpm exec vitest run apps/api/src/routes/ambient-places.test.ts`; expected: new route tests fail.
- [ ] Implement routes with auth classifications, request schemas, error budgets and bounded validated proxy. Register in core route registry; regenerate OpenAPI using existing script.
- [ ] Run the same command plus API surface checks; expected: pass and generated contract matches routes.
- [ ] Commit `feat(api): serve bounded ambient tiles and operator controls`.

### Task 4: Map overlay, duplicate ownership and admin workflow

**Files:** Create `integrations/overlay-ambient-places/{manifest.json,package.json,store.ts,map-layer.tsx,legend.tsx,preview.svg,strings/en.json,strings/de.json,map-layer.test.tsx}`; create `apps/web/src/components/map/ambientPlaceIdentity.ts` and tests; modify `mapStylePoiTarget.ts`, `MapStylePoiClickHandler.tsx` and tests; create `apps/web/src/components/admin/services/AmbientPlacesMaintenance.tsx` and tests; modify `DataWorkflowsPage.tsx`; update workspace lockfile/integration inventory.

**Interfaces:** Consumes Task 1/3. Map-instance WeakMap stores canonical basemap places; `StylePoiTarget.canonicalPlace` uses existing `categoryPlaceToPlace`. Overlay store defaults visible while respecting user changes; legend exposes source generation metadata. Admin controls call Task 3 endpoints.

- [ ] Write tests for generation replacement, stale async response, disabled/no data, style re-registration, handler teardown, canonical tap/category suppression, ambiguous branches/non-ground tenants and per-map isolation; admin successful build/rollback and error state.
- [ ] Run focused tests; expected: new feature behaviors fail.
- [ ] Implement bounded vector source/layer group, 60s abortable manifest refresh, identity-only category/selection exclusion, conservative basemap lookup and canonical hover/tap. Reuse attribution and overlay registry, localized en/de copy. Add admin controls and count/inventory metadata.
- [ ] Run focused tests; expected: all pass. Perform native T3 browser before/after, map pan/zoom/style/tap/toggle, multilingual and admin QA using disposable fixture backend when necessary.
- [ ] Commit `feat(web): show ranked ambient places and publication controls`.

### Task 5: Documentation, full verification and PR delivery

**Files:** Modify `docs/docs/features/overture-places.md`, `docs/docs/features/map-layers.md`; create `docs/docs/development/ambient-places-publication.md` (adjust to existing docs development location if needed); PR body and screenshots outside repo.

**Interfaces:** Consumes all tasks and measured evidence; produces current operator guidance and a verified feature PR.

- [ ] Update existing docs with prerequisites, policies, attribution, source ages and disable/rollback; record PMTiles/Martin comparison and measured fixture budgets with limitations.
- [ ] Run `pnpm lint`, `pnpm check-types`, `pnpm test --maxWorkers=4`, relevant API/web/data-manager builds and the real PostGIS task suite; expected: all pass. Fix actual failures with regression tests where appropriate.
- [ ] Commit `docs(places): document regional publication and validation`.
- [ ] Generate final review package and dispatch one fresh strongest-model reviewer per executing-plans skill. Fix Critical/Important findings with red→green regressions; record rulings/deferred minors; rerun affected checks and full suite if code changes.
- [ ] Push through temporary HTTPS GitHub credentials; create PR closing #399 with validation and before/after evidence. Immediately T3-link it; assign Medformatik, apply existing relevant labels, verify metadata and thread PR list. Do not merge/deploy.

## Plan self-review

All issue acceptance criteria map to Tasks 1–5. Shared contract signatures and
limits match the spec. The five failure classes each have an owning test task.
The PMTiles comparison is a measured serving decision, not new offline scope.
Source publication timestamps are explicitly distinguished from real-world
freshness. Admin mutation auth and source license credit are required, not
follow-up work. Native execution is already authorized; no approval gates.
