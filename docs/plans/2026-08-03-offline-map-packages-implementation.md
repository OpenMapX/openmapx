# Regional Offline Map Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace OpenMapX's request-per-tile offline acquisition path with measured, resumable, versioned regional PMTiles packages that render through MapLibre after a cold offline reload.

**Architecture:** The existing Planetiler/MBTiles OpenMapX dataset remains the online source. A bounded data-manager job creates an immutable PMTiles package for a canonical bbox/zoom request, publishes a manifest with exact bytes/hash/ETag/version/attribution, and exposes the archive through range-safe HTTP. The browser stores manifest metadata in IndexedDB, stores the archive in OPFS or the approved complete-blob fallback, and serves a local pmtiles://offline/<packageId> MapLibre protocol while the service worker remains responsible for the app shell and small immutable assets.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, Zod, Fastify, Node filesystem streams, Planetiler/MBTiles, PMTiles v3, MapLibre GL JS 5, IndexedDB, OPFS, Serwist service worker, React/MUI, and the existing OpenMapX data-manager/TileServer pipeline.

## Global Constraints

- Read docs/plans/2026-08-03-offline-maps-design-spec.md completely before implementing any task.
- Keep the current online default unchanged: styleProvider defaults to openmapx; the production self-hosted /tiles source remains the OpenMapX source; MapTiler is only the existing fallback when self-hosted URLs are absent.
- Generate packages only from the configured self-hosted OpenMapX dataset in version one; do not package MapTiler-hosted data.
- Use PMTiles v3 as the immutable read-only archive format; publish new bytes for every dataset/style/schema/generator change.
- Keep the current rectangular area picker and explicit min/max zoom mental model; clamp effective package max zoom to the source maximum and report requested versus effective zooms.
- A package is not ready until exact byte length, SHA-256, ETag, PMTiles metadata, pinned style assets, schema compatibility, and atomic finalization all pass.
- Store metadata in IndexedDB and the archive in OPFS or a complete-blob fallback; do not add new per-tile localStorage or Cache API acquisition.
- The service worker must not scan all saved-area caches for every tile request and must not delete package files during app-shell activation.
- Do not add offline route planning, offline rerouting, traffic, live transit, or other live-data replicas in this plan; those belong to the navigation plan or separate future work.
- Do not log raw user bboxes, route geometry, GPS coordinates, or destination data in normal telemetry.
- Preserve unrelated worktree changes. Never use git reset --hard, git checkout --, broad cleanup, or generated package binaries in Git.
- Use co-located Vitest tests and repository commands: pnpm lint, pnpm check-types, pnpm test, and the focused commands specified by each task.
- Keep each task buildable and commit each independently testable deliverable with a focused conventional commit.
- Run the browser acceptance matrix in latest supported Chrome, Firefox, and Safari with the network disabled after a cold reload.

---

## Dependency graph and file map

Implement tasks in numeric order. Task 1 is a hard POC gate: do not integrate
the API or browser reader until a local PMTiles archive can be opened and
rendered without a network request.

| Area | Files to create | Files to modify | Responsibility |
| --- | --- | --- | --- |
| Shared contract | packages/core/src/offline/offlinePackage.ts, packages/core/src/offline/index.ts, packages/core/src/offline/offlinePackage.test.ts | packages/core/src/index.ts | Canonical request, manifest/job/local statuses, validation, package IDs, coverage selection |
| PMTiles build | packages/cli/src/lib/tile-pmtiles.ts, packages/cli/src/lib/tile-pmtiles.test.ts | packages/cli/package.json, pnpm-lock.yaml, services/data-manager/Dockerfile, infra/docker/pmtiles-tool.lock.json | Pinned conversion/extraction/inspection and atomic package output |
| Data-manager package service | services/data-manager/src/offline-packages/types.ts, source-catalog.ts, storage.ts, generator.ts, queue.ts, index.ts, services/data-manager/__tests__/offline-packages.test.ts | services/data-manager/src/api.ts, services/data-manager/package.json, services/data-manager/tsconfig.json | Source descriptor, bounded jobs, disk retention, internal manifest/archive endpoints |
| Public API | apps/api/src/routes/offline-packages.ts, apps/api/src/routes/__tests__/offline-packages.test.ts | apps/api/src/server.ts | Validation, data-manager proxy, range streaming, capability errors, existing rate-limit tiers |
| Browser package store | apps/web/src/lib/offlineAreas/packageApi.ts, packageStorage.ts, packageDownload.ts, packageResolver.ts, packageProtocol.ts, legacyAreaReader.ts and their tests | apps/web/src/lib/offlineAreas/types.ts, storage.ts, index.ts, persistentStorage.ts | Typed lifecycle, IndexedDB/OPFS/fallback storage, resume, verification, deterministic coverage lookup |
| Map/style | apps/web/src/lib/offlineAreas/packageStyle.ts and test | apps/web/src/lib/map.ts, apps/web/src/app/settings/offline/OfflineMapView.tsx | Local protocol registration, pinned OpenMapX style variants, offline tile coverage state |
| Service worker | apps/web/src/lib/offlineAreas/packageWorkerMessages.ts and test | apps/web/src/sw.ts, apps/web/src/lib/swCaches.ts, apps/web/src/lib/swCaches.test.ts, apps/web/src/lib/swAutoUpdate.ts | App shell/small assets, package-preserving activation, legacy migration messages |
| Settings UX | apps/web/src/app/settings/offline/OfflinePackageStatus.tsx and test | apps/web/src/app/settings/offline/OfflineSettingsClient.tsx, AreaPickerMap.tsx, packages/i18n/locales/en.json, packages/i18n/locales/de.json | Preparation/transfer/verification UI, exact bytes, quota/errors, provider capability copy |
| Migration/docs/metrics | apps/web/src/lib/offlineAreas/packageMetrics.ts and test, docs/docs/features/offline-maps.md | docs/docs/guides/map-tiles.md, docs/sidebars.ts, package logging call sites | Operational metrics, attribution, provider boundary, user/operator documentation |

The implementer may split a listed production file only when the split preserves
the named interface and keeps the old behavior covered. Do not move unrelated
map or navigation code during this work.

## Shared interfaces used by later tasks

Task 2 defines the canonical types consumed by every later task. The following
names and meanings are fixed for this plan.

~~~ts
export interface OfflinePackageBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OfflinePackageRequest {
  bbox: OfflinePackageBbox;
  minZoom: number;
  maxZoom: number;
  provider: "openmapx";
}

export interface OfflinePackageSourceDescriptor {
  datasetId: "openmapx";
  datasetVersion: string;
  sourceMaxZoom: number;
  sourceBounds: OfflinePackageBbox;
  tileSchema: "openmaptiles";
  styleProvider: "openmapx";
  styleVersion: string;
  packageAlgorithmVersion: string;
  attribution: string[];
}

export interface CanonicalOfflinePackageRequest {
  request: OfflinePackageRequest;
  effective: {
    bbox: OfflinePackageBbox;
    minZoom: number;
    maxZoom: number;
  };
  source: OfflinePackageSourceDescriptor;
  requestKey: string;
}

export type OfflinePackageJobStatus =
  | "preparing"
  | "ready-to-download"
  | "failed"
  | "expired";

export type OfflinePackageLocalStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "paused"
  | "verifying"
  | "ready"
  | "error"
  | "deleting";

export interface OfflineMapPackageManifest {
  schemaVersion: 1;
  packageId: string;
  requestKey: string;
  dataset: {
    id: "openmapx";
    version: string;
    generatedAt: string;
    sourceMaxZoom: number;
    tileSchema: "openmaptiles";
  };
  coverage: {
    bbox: OfflinePackageBbox;
    minZoom: number;
    maxZoom: number;
  };
  archive: {
    url: string;
    contentType: "application/vnd.pmtiles";
    byteLength: number;
    sha256: string;
    etag: string;
  };
  style: {
    provider: "openmapx";
    version: string;
    variants: Array<"light" | "dark">;
    assetBaseUrl: string;
  };
  attribution: string[];
}

export interface OfflinePackageJob {
  jobId: string;
  requestKey: string;
  status: OfflinePackageJobStatus;
  packageId?: string;
  manifest?: OfflineMapPackageManifest;
  errorCode?:
    | "unsupported-provider"
    | "invalid-request"
    | "capacity"
    | "generation-failed"
    | "expired";
  errorMessage?: string;
}

export interface OfflinePackageCapability {
  available: boolean;
  provider: "openmapx";
  sourceMaxZoom?: number;
  sourceBounds?: OfflinePackageBbox;
  reason?: "unsupported-provider" | "source-unavailable" | "capacity";
}
~~~

The browser package API, data-manager API, and public API must use these exact
status values and manifest meanings. Transport-specific envelopes may add
request IDs or timestamps, but they must not rename the shared fields.

## Tasks

### Task 0: Capture a clean baseline and verify repository drift

**Files:**

- Read only: apps/web/src/lib/env.ts, apps/web/src/lib/map.ts, apps/web/src/lib/offlineAreas/*, apps/web/src/app/settings/offline/*, apps/web/src/sw.ts, packages/core/src/stores/navigationStore.ts, packages/cli/src/lib/tile-mbtiles.ts, services/data-manager/src/jobs/download-style.ts
- Test-only output: a local temporary directory outside the repository; do not add generated archives to Git.

**Interfaces:**

- Consumes: baseline commit a242b5a39faf045b23ab54bc0799bf71b35d00a2 and the current worktree.
- Produces: a written baseline table in the implementation handoff containing source maxzoom/bounds, current asset count, request count, wall time, bytes, and storage usage for one synthetic fixture and one operator-selected representative region.

- [ ] **Step 1: Check working-tree drift before touching source files.**

Run:

~~~bash
git status --short
git diff --stat a242b5a39faf045b23ab54bc0799bf71b35d00a2 -- apps/web/src/lib/offlineAreas apps/web/src/app/settings/offline apps/web/src/sw.ts packages/core/src/stores/navigationStore.ts packages/cli/src/lib/tile-mbtiles.ts services/data-manager/src/jobs/download-style.ts
~~~

Expected: unrelated transit/CLI changes remain visible, and any change in the
listed offline seams is reread before implementation decisions continue.

- [ ] **Step 2: Run current focused tests and record their results.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/tiles.test.ts
pnpm exec vitest run packages/core/src/stores/navigationStore.test.ts
pnpm --filter @openmapx/cli check-types
pnpm --filter web check-types
~~~

Expected: the baseline commands pass. A failure is recorded as pre-existing or
fixed by the task that owns the affected seam; do not hide it in the package
implementation.

- [ ] **Step 3: Capture current acquisition cost without user data.**

Use a synthetic bbox and the operator-approved representative region. Record the
current downloader's asset URL count, successful HTTP request count, response
bytes, wall time, and final Cache API usage. Do not send these values to
production telemetry and do not commit the archive.

- [ ] **Step 4: Leave the repository clean when no fixture change is required.**

Baseline measurements are handoff data, not product source. Do not stage or
commit them. When a reusable fixture is required, return to the task that owns
that fixture and commit only its exact file path.

### Task 1: Prove PMTiles conversion, extraction, and local reading

**Files:**

- Create: packages/cli/src/lib/tile-pmtiles.ts
- Create: packages/cli/src/lib/tile-pmtiles.test.ts
- Create: infra/docker/pmtiles-tool.lock.json
- Modify: packages/cli/package.json, services/data-manager/Dockerfile, pnpm-lock.yaml
- Test fixture: packages/cli/src/lib/fixtures/tile-pmtiles/ containing JSON metadata and generated-at-test-time temporary archives only

**Interfaces:**

- Consumes: an existing MBTiles path, CanonicalOfflinePackageRequest, and a pinned PMTiles conversion/extraction executable/library.
- Produces: inspectPmtiles(path), extractPmtilesPackage(options), hashFile(path), and validatePmtilesPackage(path, expected) for Tasks 3–5, plus a verified browser-readable archive adapter contract for Task 9.

Define the Node-side interface before selecting tool flags:

~~~ts
export interface PmtilesPackageOptions {
  sourceMbtilesPath: string;
  destinationPath: string;
  request: CanonicalOfflinePackageRequest;
}

export interface PmtilesPackageMetadata {
  byteLength: number;
  sha256: string;
  etag: string;
  bounds: OfflinePackageBbox;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  attribution: string[];
}

export async function extractPmtilesPackage(
  options: PmtilesPackageOptions,
): Promise<PmtilesPackageMetadata>;

export async function validatePmtilesPackage(
  path: string,
  expected: Pick<
    PmtilesPackageMetadata,
    "byteLength" | "sha256" | "bounds" | "minZoom" | "maxZoom"
  >,
): Promise<PmtilesPackageMetadata>;
~~~

- [ ] **Step 1: Write failing fixture tests for package invariants.**

Add tests named exactly:

Required test cases:
- extracts an inside tile and excludes a tile outside the requested bbox
- clamps the package max zoom to the source max zoom
- preserves source bounds and attribution in package metadata
- uses the same request key and bytes for repeated canonical requests
- changes the package identity when the dataset version changes
- does not publish a final file when extraction validation fails
- opens the finalized archive through the browser reader adapter

Use generated temporary fixtures and remove them in afterEach. Assert exact tile
lookup outcomes, not only command exit status.

- [ ] **Step 2: Run the focused tests and confirm the new API is absent or failing.**

~~~bash
pnpm exec vitest run packages/cli/src/lib/tile-pmtiles.test.ts
~~~

Expected: FAIL for missing adapter/functions or missing pinned tool. Keep the
failure output as the starting point for implementation.

- [ ] **Step 3: Pin the PMTiles tool/library and record its invocation.**

Use the pmtiles JavaScript package for browser reading and the repository-approved
PMTiles conversion tool for Node/data-manager extraction. Record the exact
package/binary version, download URL, SHA-256, executable path, and
conversion/extraction flags in infra/docker/pmtiles-tool.lock.json and the
Docker/package manifests. Do not use a floating latest tag.

The lock record must contain concrete values for tool, version, sha256, command,
convertArgs, and extractArgs. The committed file must contain no unresolved
placeholder values.

- [ ] **Step 4: Implement atomic extraction and metadata validation.**

Write to a sibling temporary path, run conversion/extraction, inspect the PMTiles
header/metadata, compute incremental SHA-256 and byte length, compare canonical
bbox/zoom expectations, and rename only after all checks pass. Delete the
temporary file on every failure. Return an ETag derived from the SHA-256 in the
form sha256-<hash> so later HTTP resume checks use immutable identity.

- [ ] **Step 5: Run the POC tests and check types.**

~~~bash
pnpm exec vitest run packages/cli/src/lib/tile-pmtiles.test.ts
pnpm --filter @openmapx/cli check-types
~~~

Expected: all named invariant tests pass and no final archive exists after the
failure test.

- [ ] **Step 6: Commit the POC as a separately reviewable gate.**

~~~bash
git add packages/cli/src/lib/tile-pmtiles.ts packages/cli/src/lib/tile-pmtiles.test.ts packages/cli/package.json services/data-manager/Dockerfile infra/docker/pmtiles-tool.lock.json pnpm-lock.yaml
git commit -m "feat: add validated PMTiles package extraction"
~~~

### Task 2: Add the shared offline-package contract and canonicalization

**Files:**

- Create: packages/core/src/offline/offlinePackage.ts
- Create: packages/core/src/offline/index.ts
- Create: packages/core/src/offline/offlinePackage.test.ts
- Modify: packages/core/src/index.ts

**Interfaces:**

- Consumes: OfflinePackageRequest, OfflinePackageSourceDescriptor, and PMTiles metadata from Task 1.
- Produces: the shared types above plus canonicalizeOfflinePackageRequest, offlinePackageRequestKey, validateOfflineMapPackageManifest, packageContainsPoint, and selectOfflinePackage.

- [ ] **Step 1: Write failing pure tests for canonicalization and selection.**

Create tests named:

Required test cases:
- normalizes decimal coordinates and zoom values into one request key
- rejects non-finite coordinates, inverted bounds, negative zooms, and invalid provider
- clamps latitude and returns requested and effective max zoom separately
- rejects a dateline-crossing bbox instead of expanding it to the opposite world side
- rejects a bbox outside the source bounds
- rejects a package manifest with a wrong hash, length, schema, or provider
- selects the most specific compatible package deterministically
- does not select an overlapping package with an incompatible dataset or style

Use this canonicalization assertion:

~~~ts
const result = canonicalizeOfflinePackageRequest(
  {
    bbox: { west: 13.4000004, south: 52.49, east: 13.6000004, north: 52.6 },
    minZoom: 10,
    maxZoom: 18,
    provider: "openmapx",
  },
  source,
);
expect(result.effective.maxZoom).toBe(source.sourceMaxZoom);
expect(result.request.maxZoom).toBe(18);
expect(result.requestKey).toBe(offlinePackageRequestKey(result));
~~~

- [ ] **Step 2: Run the tests and confirm the contract is not implemented.**

~~~bash
pnpm exec vitest run packages/core/src/offline/offlinePackage.test.ts
~~~

Expected: FAIL with missing exports or incorrect canonicalization.

- [ ] **Step 3: Implement types, Zod manifest validation, and canonicalization.**

Use the source descriptor's datasetVersion, tileSchema, styleVersion,
packageAlgorithmVersion, effective bbox, effective zooms, and provider to build
a stable requestKey. Clamp latitude to ±85.05112878, normalize longitude into
[-180, 180], reject dateline crossing, round coordinates to six decimal places,
and enforce source bounds and the configured area cap. Preserve requested max
zoom in the canonical result while using source max zoom for the effective
package.

selectOfflinePackage must rank candidates by compatible schema/style, containing
coverage, smallest covering area, newest dataset version, and lexicographic
package ID. Export the compatibility predicate so browser and navigation code
use the same rule.

- [ ] **Step 4: Export the contract and run focused checks.**

~~~bash
pnpm exec vitest run packages/core/src/offline/offlinePackage.test.ts
pnpm --filter @openmapx/core check-types
~~~

Expected: all pure tests pass and importing
canonicalizeOfflinePackageRequest from @openmapx/core type-checks.

- [ ] **Step 5: Commit the shared contract.**

~~~bash
git add packages/core/src/offline packages/core/src/index.ts
git commit -m "feat: define offline map package contract"
~~~

### Task 3: Implement the data-manager package source catalog and storage layout

**Files:**

- Create: services/data-manager/src/offline-packages/types.ts
- Create: services/data-manager/src/offline-packages/source-catalog.ts
- Create: services/data-manager/src/offline-packages/storage.ts
- Create: services/data-manager/src/offline-packages/index.ts
- Create: services/data-manager/__tests__/offline-packages.test.ts
- Modify: services/data-manager/package.json, services/data-manager/tsconfig.json

**Interfaces:**

- Consumes: shared contract from Task 2, existing dataDir/source state, and data/tile-mbtiles/tiles.mbtiles.
- Produces: getOpenMapxPackageSource(), packageDirectory(packageId), readPublishedManifest(packageId), openPublishedArchive(packageId), listPublishedPackages(), and reconcileOfflinePackageStorage().

Define the source catalog return type:

~~~ts
export interface OfflinePackageSourceCatalog {
  descriptor: OfflinePackageSourceDescriptor;
  mbtilesPath: string;
  styleDirectory: string;
  packageRoot: string;
}
~~~

- [ ] **Step 1: Write failing filesystem tests for safe paths and atomic visibility.**

Test these exact cases:

Required test cases:
- maps a validated package ID to one package directory under the configured root
- rejects slash, dot-dot, empty, and non-content-addressed package IDs
- reads a manifest only when both manifest and archive exist
- lists only complete published packages
- removes abandoned temporary files without touching ready packages
- keeps a previous ready package visible when a replacement generation fails

- [ ] **Step 2: Run tests and confirm the storage API is absent.**

~~~bash
pnpm exec vitest run services/data-manager/__tests__/offline-packages.test.ts
~~~

Expected: FAIL for missing modules/functions.

- [ ] **Step 3: Resolve the OpenMapX source descriptor from existing artifacts.**

Read the same MBTiles/config/style locations used by the current TileServer path.
Return dataset build ID, source bounds, source max zoom, OpenMapTiles schema,
OpenMapX style version, style directory, and OSM/OpenMapTiles attribution. When
the source is not the self-hosted OpenMapX dataset, return a typed
unsupported-provider capability instead of falling back to MapTiler.

- [ ] **Step 4: Implement path-safe package storage and startup reconciliation.**

Use this layout:

~~~text
<packageRoot>/<packageId>/package.pmtiles
<packageRoot>/<packageId>/manifest.json
<packageRoot>/.tmp/<jobId>.pmtiles.part
<packageRoot>/.tmp/<jobId>.manifest.part
~~~

Write and fsync the archive, validate it, write the manifest, fsync the
directory, then rename the temporary package directory into the final package
directory. readPublishedManifest must verify that the archive exists and that
the manifest package ID matches the directory before returning it. Use lstat and
realpath checks to prevent symlink traversal.

- [ ] **Step 5: Run tests, type-check, and commit.**

~~~bash
pnpm exec vitest run services/data-manager/__tests__/offline-packages.test.ts
pnpm --filter @openmapx/data-manager check-types
git add services/data-manager/src/offline-packages services/data-manager/__tests__/offline-packages.test.ts services/data-manager/package.json services/data-manager/tsconfig.json
git commit -m "feat: add offline package source catalog"
~~~

### Task 4: Add bounded package generation, single-flight jobs, and retention

**Files:**

- Create: services/data-manager/src/offline-packages/generator.ts
- Create: services/data-manager/src/offline-packages/queue.ts
- Modify: services/data-manager/src/offline-packages/types.ts, index.ts
- Modify: services/data-manager/__tests__/offline-packages.test.ts

**Interfaces:**

- Consumes: getOpenMapxPackageSource, storage from Task 3, and extractPmtilesPackage from Task 1.
- Produces: prepareOfflinePackage(input), getOfflinePackageJob(jobId), cancelExpiredOfflinePackageJobs(), and reconcileOfflinePackageStorage().

Use this service interface:

~~~ts
export interface OfflinePackagePreparation {
  jobId: string;
  request: CanonicalOfflinePackageRequest;
  status: OfflinePackageJobStatus;
  packageId?: string;
  manifest?: OfflineMapPackageManifest;
  errorCode?: OfflinePackageJob["errorCode"];
  errorMessage?: string;
}

export interface OfflinePackageGenerator {
  prepare(request: OfflinePackageRequest): Promise<OfflinePackagePreparation>;
  getJob(jobId: string): OfflinePackagePreparation | undefined;
  getManifest(packageId: string): Promise<OfflineMapPackageManifest | undefined>;
}
~~~

- [ ] **Step 1: Write failing queue tests for idempotence and limits.**

Add tests named:

Required test cases:
- shares one job when two callers prepare the same canonical request
- creates distinct jobs for distinct request keys
- rejects a request above the area or effective-zoom cap before extraction
- returns ready-to-download with measured bytes after successful publication
- returns generation-failed and preserves an older ready package after extraction failure
- limits concurrent extractions to the configured worker count
- does not evict a package referenced by an active stream
- expires unreferenced packages under the disk budget

- [ ] **Step 2: Run the new queue tests before implementation.**

~~~bash
pnpm exec vitest run services/data-manager/__tests__/offline-packages.test.ts
~~~

Expected: FAIL for missing queue/generator behavior.

- [ ] **Step 3: Implement canonical job identity and single-flight state.**

Canonicalize through Task 2 before allocating a job. Keep an in-memory map by
requestKey and a job map by jobId; after process restart, recover complete
published manifests from storage before starting new extraction. Equal requests
return the same job/package; a changed dataset or style descriptor creates a new
request key.

- [ ] **Step 4: Implement bounded extraction and atomic publication.**

Call extractPmtilesPackage with the MBTiles source and a temporary path. Build the
manifest only from returned validated metadata. Persist status transitions
preparing to ready-to-download or preparing to failed; never expose a manifest
before the final archive is visible.

- [ ] **Step 5: Implement disk budget and safe retention.**

Use explicit byte and package-count limits from environment configuration with
validated defaults. Exclude packages with active stream reference counts and the
newest package for the current dataset. Remove abandoned part files at startup
after verifying that they are not owned by a live job.

- [ ] **Step 6: Run focused tests and commit.**

~~~bash
pnpm exec vitest run services/data-manager/__tests__/offline-packages.test.ts
pnpm --filter @openmapx/data-manager check-types
git add services/data-manager/src/offline-packages services/data-manager/__tests__/offline-packages.test.ts
git commit -m "feat: generate offline packages with bounded jobs"
~~~

### Task 5: Expose internal preparation, manifest, and range archive endpoints

**Files:**

- Modify: services/data-manager/src/api.ts
- Create: services/data-manager/__tests__/offline-packages-api.test.ts
- Modify: services/data-manager/src/index.ts only to initialize and reconcile the package generator before route registration

**Interfaces:**

- Consumes: OfflinePackageGenerator from Task 4 and OfflineMapPackageManifest from Task 2.
- Produces: internal endpoints consumed by apps/api/src/routes/offline-packages.ts:
  - GET /offline/packages/capability
  - POST /offline/packages/prepare
  - GET /offline/packages/jobs/:jobId
  - GET /offline/packages/:packageId/manifest
  - HEAD /offline/packages/:packageId/archive
  - GET /offline/packages/:packageId/archive

- [ ] **Step 1: Write failing Fastify injection tests for each endpoint.**

Assert these outcomes:

~~~ts
expect((await app.inject({ method: "GET", url: "/offline/packages/capability" })).statusCode).toBe(200);
expect((await app.inject({ method: "POST", url: "/offline/packages/prepare", payload: validRequest })).statusCode).toBe(202);
expect((await app.inject({ method: "GET", url: "/offline/packages/jobs/job-1" })).statusCode).toBe(200);
expect((await app.inject({ method: "GET", url: "/offline/packages/missing/manifest" })).statusCode).toBe(404);
expect((await app.inject({ method: "HEAD", url: "/offline/packages/pkg-1/archive" })).headers["accept-ranges"]).toBe("bytes");
expect((await app.inject({ method: "GET", url: "/offline/packages/pkg-1/archive", headers: { range: "bytes=0-31" } })).statusCode).toBe(206);
~~~

Also test unauthorized service-token calls, invalid JSON, unsupported provider,
invalid job/package IDs, suffix ranges, unsatisfiable ranges (416), and changed
If-Range/ETag behavior.

- [ ] **Step 2: Run endpoint tests and confirm missing routes fail.**

~~~bash
pnpm exec vitest run services/data-manager/__tests__/offline-packages-api.test.ts
~~~

- [ ] **Step 3: Register authenticated routes in services/data-manager/src/api.ts.**

Reuse existing service auth and response style. Validate request bodies with the
shared contract before invoking the generator. Return 202 for a new or running
preparation, 200 for an already-ready manifest, 409 for capacity, 404 for
unknown/expired IDs, and a typed unsupported-provider body for an unavailable
source.

- [ ] **Step 4: Implement range-safe streaming from the published file.**

For HEAD, stat the validated archive and return Content-Length, ETag,
Accept-Ranges: bytes, Content-Type: application/vnd.pmtiles, and immutable cache
headers. For GET, stream the full file with 200; for one valid range, stream only
the inclusive byte interval with 206 and Content-Range:
bytes <start>-<end>/<total>; for invalid ranges return 416 with
Content-Range: bytes */<total>. Increment and decrement the generator's active
stream reference count around the stream lifecycle.

- [ ] **Step 5: Run tests, type-check, and commit.**

~~~bash
pnpm exec vitest run services/data-manager/__tests__/offline-packages-api.test.ts
pnpm --filter @openmapx/data-manager check-types
git add services/data-manager/src/api.ts services/data-manager/src/index.ts services/data-manager/__tests__/offline-packages-api.test.ts
git commit -m "feat: serve offline package manifests and ranges"
~~~

### Task 6: Add the public apps/api package route and capability boundary

**Files:**

- Create: apps/api/src/routes/offline-packages.ts
- Create: apps/api/src/routes/__tests__/offline-packages.test.ts
- Modify: apps/api/src/server.ts

**Interfaces:**

- Consumes: internal data-manager endpoints from Task 5 and shared request/manifest types from Task 2.
- Produces: browser-facing routes:
  - GET /api/offline/packages/capability
  - POST /api/offline/packages/prepare
  - GET /api/offline/packages/jobs/:jobId
  - GET /api/offline/packages/:packageId/manifest
  - HEAD /api/offline/packages/:packageId/archive
  - GET /api/offline/packages/:packageId/archive

- [ ] **Step 1: Write failing route tests with Fastify inject.**

Test the public route with mocked internal fetch and assert:

Required test cases:
- returns normalized preparation data without pretending to know transfer bytes
- returns the exact manifest and attribution
- forwards HEAD headers without buffering the archive
- forwards a 206 range body and Content-Range
- returns 416 for an unsatisfiable range
- rejects path traversal and arbitrary package IDs
- returns a typed unavailable capability for a MapTiler-only deployment
- returns the Fastify reply from every error branch

- [ ] **Step 2: Run route tests and confirm they fail.**

~~~bash
pnpm exec vitest run apps/api/src/routes/__tests__/offline-packages.test.ts
~~~

- [ ] **Step 3: Implement the Fastify plugin and register it under /api.**

Use the existing FastifyPluginAsync route style and server.register pattern. Send
only validated bodies to data-manager. Do not accept filesystem paths, remote
URLs, caller-supplied file names, or unbounded numeric values.

- [ ] **Step 4: Proxy the archive as a stream, not an arrayBuffer.**

Forward Range and If-Range headers to data-manager, copy only approved archive
headers, and return the upstream body as a stream supported by the current
Fastify version. Set Cache-Control public, max-age=31536000, immutable only for
content-addressed package IDs. Do not log request bboxes or route data.

- [ ] **Step 5: Run route tests and API type checks, then commit.**

~~~bash
pnpm exec vitest run apps/api/src/routes/__tests__/offline-packages.test.ts
pnpm --filter @openmapx/api check-types
git add apps/api/src/routes/offline-packages.ts apps/api/src/routes/__tests__/offline-packages.test.ts apps/api/src/server.ts
git commit -m "feat: expose offline package API"
~~~

### Task 7: Create browser IndexedDB metadata and archive storage adapters

**Files:**

- Create: apps/web/src/lib/offlineAreas/packageStorage.ts
- Create: apps/web/src/lib/offlineAreas/packageStorage.test.ts
- Modify: apps/web/src/lib/offlineAreas/types.ts, storage.ts, index.ts, persistentStorage.ts

**Interfaces:**

- Consumes: OfflineMapPackageManifest, OfflinePackageLocalStatus, and browser storage APIs.
- Produces: OfflinePackageStorage consumed by Tasks 8–12.

~~~ts
export interface OfflinePackageRecord {
  id: string;
  name: string;
  manifest: OfflineMapPackageManifest;
  status: OfflinePackageLocalStatus;
  bytesReceived: number;
  bytesTotal: number;
  verifiedPrefixBytes: number;
  createdAt: number;
  updatedAt: number;
  downloadedAt?: number;
  lastError?: { code: string; message: string };
  legacyAreaId?: string;
}

export interface OfflinePackageStorage {
  list(): Promise<OfflinePackageRecord[]>;
  get(packageId: string): Promise<OfflinePackageRecord | undefined>;
  put(record: OfflinePackageRecord): Promise<void>;
  delete(packageId: string): Promise<void>;
  openPartial(packageId: string): Promise<OfflineArchiveFile>;
  finalize(packageId: string): Promise<void>;
  openReady(packageId: string): Promise<OfflineArchiveFile>;
  estimate(): Promise<StorageEstimate>;
}

export interface OfflineArchiveFile {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  append(chunk: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
~~~

- [ ] **Step 1: Write failing storage tests.**

Test with fake IndexedDB and a fake OPFS adapter:

Required test cases:
- persists one package record without rewriting unrelated records
- stores partial and ready archives under distinct names
- returns an OPFS adapter when navigator.storage is available
- uses the complete-blob fallback when OPFS is unavailable
- does not expose a partial archive through openReady
- finalize changes metadata to ready only after the file rename
- surfaces quota errors without deleting existing ready packages
- deletes metadata and both archive states after reader release

- [ ] **Step 2: Implement a versioned IndexedDB store and OPFS adapter.**

Use database openmapx-offline with object store packages and schema version 1.
Store records by packageId; update only that record at bounded intervals. Store
OPFS files as packages/<packageId>.pmtiles.part and
packages/<packageId>.pmtiles, using an atomic move. The fallback stores one
complete Blob per package and rejects resume until a complete body is
available; the UI must display the fallback size limit before starting.

- [ ] **Step 3: Keep legacy metadata/cache access read-only.**

Leave listAreas, cacheNameFor, and deleteAreaCache available for Task 13's
migration. New package records must not be serialized into
openmapx-offline-areas-v1 or a per-tile cache.

- [ ] **Step 4: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/packageStorage.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/offlineAreas/packageStorage.ts apps/web/src/lib/offlineAreas/packageStorage.test.ts apps/web/src/lib/offlineAreas/types.ts apps/web/src/lib/offlineAreas/storage.ts apps/web/src/lib/offlineAreas/index.ts apps/web/src/lib/persistentStorage.ts
git commit -m "feat: add offline package browser storage"
~~~

### Task 8: Implement the typed package API and resumable byte downloader

**Files:**

- Create: apps/web/src/lib/offlineAreas/packageApi.ts
- Create: apps/web/src/lib/offlineAreas/packageDownload.ts
- Create: apps/web/src/lib/offlineAreas/packageApi.test.ts
- Create: apps/web/src/lib/offlineAreas/packageDownload.test.ts
- Modify: apps/web/src/lib/offlineAreas/types.ts, index.ts

**Interfaces:**

- Consumes: public routes from Task 6 and OfflinePackageStorage from Task 7.
- Produces: OfflinePackageApi, downloadOfflinePackage, and exact byte progress for Tasks 9–12.

~~~ts
export interface OfflinePackageApi {
  capability(signal?: AbortSignal): Promise<OfflinePackageCapability>;
  prepare(request: OfflinePackageRequest, signal?: AbortSignal): Promise<OfflinePackageJob>;
  getJob(jobId: string, signal?: AbortSignal): Promise<OfflinePackageJob>;
  getManifest(packageId: string, signal?: AbortSignal): Promise<OfflineMapPackageManifest>;
  openArchive(packageId: string, range?: { start: number }, signal?: AbortSignal): Promise<Response>;
}

export interface OfflinePackageDownloadProgress {
  packageId: string;
  status: "preparing" | "downloading" | "paused" | "verifying" | "ready" | "error";
  bytesReceived: number;
  bytesTotal: number;
  speedBytesPerSecond: number;
  error?: { code: string; message: string };
}

export async function downloadOfflinePackage(
  api: OfflinePackageApi,
  storage: OfflinePackageStorage,
  manifest: OfflineMapPackageManifest,
  options: {
    signal?: AbortSignal;
    onProgress?: (p: OfflinePackageDownloadProgress) => void;
  },
): Promise<OfflinePackageRecord>;
~~~

- [ ] **Step 1: Write failing API/downloader tests.**

Add tests for:

Required test cases:
- polls preparation until the manifest has an exact byte length
- starts a fresh GET at byte zero and records measured progress
- resumes from the verified contiguous prefix with one Range request
- restarts instead of appending when the ETag changes
- pauses on AbortError without marking the package ready
- rejects a length mismatch and checksum mismatch
- marks ready only after PMTiles and style verification succeeds
- reports quota and HTTP errors with stable error codes

Use a fake ReadableStream<Uint8Array> and assert the requested range and final
byte count:

~~~ts
expect(fetchMock).toHaveBeenCalledWith(
  "/api/offline/packages/pkg-1/archive",
  expect.objectContaining({
    headers: expect.objectContaining({ Range: "bytes=1024-" }),
  }),
);
expect(progress.at(-1)?.bytesReceived).toBe(manifest.archive.byteLength);
~~~

- [ ] **Step 2: Implement manifest polling and exact progress.**

Poll job status with increasing delay capped at five seconds. Transition the
record from preparing to downloading only when the manifest has positive
byteLength, valid hash/ETag, and compatible style. Use transport
Content-Length/Content-Range as checks but use the manifest as authoritative
total.

- [ ] **Step 3: Implement contiguous-prefix resume and integrity verification.**

Read verifiedPrefixBytes from metadata, send Range bytes=<prefix>-, require 206
and a matching ETag for a nonzero prefix, append chunks, and persist progress at
least every one second or every four MiB. Truncate to the last verified prefix
after interruption. Stream an incremental SHA-256 through a worker or chunked
Web Crypto implementation; never load a large archive into one arrayBuffer.

- [ ] **Step 4: Implement atomic ready transition and cancellation.**

After exact length/hash and PMTiles/style validation, call storage.finalize,
then persist status ready and downloadedAt in one ordered sequence. On abort,
set paused; on non-retryable failure, set error; on delete, close all readers
before removing files and metadata.

- [ ] **Step 5: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/packageApi.test.ts apps/web/src/lib/offlineAreas/packageDownload.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/offlineAreas/packageApi.ts apps/web/src/lib/offlineAreas/packageDownload.ts apps/web/src/lib/offlineAreas/packageApi.test.ts apps/web/src/lib/offlineAreas/packageDownload.test.ts apps/web/src/lib/offlineAreas/types.ts apps/web/src/lib/offlineAreas/index.ts
git commit -m "feat: download offline packages with resumable byte progress"
~~~

### Task 9: Add deterministic package coverage resolution and local PMTiles protocol

**Files:**

- Create: apps/web/src/lib/offlineAreas/packageResolver.ts
- Create: apps/web/src/lib/offlineAreas/packageProtocol.ts
- Create: apps/web/src/lib/offlineAreas/packageResolver.test.ts
- Create: apps/web/src/lib/offlineAreas/packageProtocol.test.ts
- Modify: apps/web/src/lib/offlineAreas/index.ts
- Modify: apps/web/package.json, pnpm-lock.yaml to add the exact POC-approved pmtiles reader version

**Interfaces:**

- Consumes: selectOfflinePackage from Task 2, ready records/storage from Task 7, and the exact pmtiles reader API proven in Task 1.
- Produces: createOfflinePackageResolver, registerOfflinePmtilesProtocol, and OfflineCoverageState for Tasks 10–13 and Plan B.

~~~ts
export type OfflineCoverageState =
  | { kind: "covered"; packageId: string }
  | { kind: "not-downloaded"; coordinate: [number, number] }
  | { kind: "incompatible"; packageId: string; reason: string };

export interface OfflinePackageResolver {
  refresh(): Promise<void>;
  packageForCoordinate(
    coordinate: [number, number],
    allowedPackageIds?: readonly string[],
  ): OfflinePackageRecord | undefined;
  coverageForCoordinate(
    coordinate: [number, number],
  ): OfflineCoverageState;
  packageIdsForGeometry(
    coordinates: readonly [number, number][],
  ): string[];
  compatiblePackageIds(): string[];
}

export function registerOfflinePmtilesProtocol(
  maplibre: { addProtocol(name: string, handler: unknown): void },
  resolver: OfflinePackageResolver,
): () => void;
~~~

- [ ] **Step 1: Write failing resolver/protocol tests.**

Test:

Required test cases:
- selects the smallest compatible ready package containing a coordinate
- uses the stable package ID tie-breaker for equal coverage
- returns not-downloaded when no ready package contains the coordinate
- rejects incompatible dataset/style/schema packages
- registers the pmtiles protocol only once
- serves a known local z/x/y tile without calling fetch
- returns a controlled missing-coverage error for an offline tile miss

- [ ] **Step 2: Implement the IndexedDB-backed resolver index.**

Load ready package records once, index bbox/zoom/schema/style fields in memory,
and refresh after download/finalize/delete messages. Delegate ranking to the
shared selectOfflinePackage; do not scan Cache Storage or perform one metadata
read per tile. Honor allowedPackageIds so a navigation session can restrict a
coverage check to the package IDs saved with that route. Implement
packageIdsForGeometry by returning ready compatible package IDs that contain at
least one supplied route coordinate.

- [ ] **Step 3: Adapt the exact PMTiles reader API to local archive reads.**

Use the Task 1-approved reader version. Implement its source/range interface over
OfflineArchiveFile.read(offset, length). A local protocol request must never
call the public archive URL when the record is ready. Keep package IDs opaque
and validate them through the resolver before opening a file.

- [ ] **Step 4: Register and unregister the MapLibre protocol safely.**

Register pmtiles once per MapLibre runtime and return a cleanup function for
tests/unmount. Convert the reader response to the MapLibre GL JS 5 protocol
response shape. Surface a typed coverage error to the map controller instead of
throwing an uncaught protocol exception.

- [ ] **Step 5: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/packageResolver.test.ts apps/web/src/lib/offlineAreas/packageProtocol.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/offlineAreas/packageResolver.ts apps/web/src/lib/offlineAreas/packageProtocol.ts apps/web/src/lib/offlineAreas/packageResolver.test.ts apps/web/src/lib/offlineAreas/packageProtocol.test.ts apps/web/src/lib/offlineAreas/index.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat: read offline packages through MapLibre"
~~~

### Task 10: Pin OpenMapX style variants and integrate local map rendering

**Files:**

- Create: apps/web/src/lib/offlineAreas/packageStyle.ts
- Create: apps/web/src/lib/offlineAreas/packageStyle.test.ts
- Modify: apps/web/src/lib/map.ts, apps/web/src/app/settings/offline/OfflineMapView.tsx, apps/web/src/lib/offlineAreas/styleAssets.ts, apps/web/src/lib/offlineAreas/index.ts

**Interfaces:**

- Consumes: ready manifests/resolver/protocol from Tasks 7–9 and existing loadOpenMapXStyle behavior in apps/web/src/lib/map.ts.
- Produces: resolveOfflinePackageStyle(manifest, variant), validateOfflineStyleAssets(manifest), and map style selection that works for both light and dark variants.

- [ ] **Step 1: Write failing style tests.**

Assert:

Required test cases:
- rewrites the OpenMapX vector source to pmtiles://offline/<packageId>
- uses the same package archive for light and dark style variants
- pins glyph and sprite URLs to the manifest style version
- rejects a manifest when a required style asset is unavailable
- does not rewrite MapTiler fallback styles into OpenMapX packages

- [ ] **Step 2: Implement style asset validation and immutable asset URLs.**

Resolve both OpenMapX style variants before download completion, validate every
required glyph/sprite/style response, retain OSM/OpenMapTiles attribution, and
bind all asset URLs to manifest.style.version. Do not use the current mutable
environment style to render an old package.

- [ ] **Step 3: Integrate local source into map.ts without changing online defaults.**

When the resolver returns a compatible package and the map is inside coverage,
rewrite only the OpenMapX vector source to the local protocol. Outside coverage
or when the browser is online without a selected package, keep current
env.tilesUrl/MapTiler fallback behavior unchanged. A MapTiler-only deployment
must not pass through the OpenMapX package path.

- [ ] **Step 4: Make OfflineMapView select the saved manifest/style version.**

Replace current-environment-only style resolution with the package record and
manifest selected for the preview. Render attribution from the package
manifest. Show a stable area-not-downloaded state for an offline tile miss.

- [ ] **Step 5: Run tests, type-check, and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/packageStyle.test.ts apps/web/src/lib/offlineAreas/packageProtocol.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/offlineAreas/packageStyle.ts apps/web/src/lib/offlineAreas/packageStyle.test.ts apps/web/src/lib/map.ts apps/web/src/app/settings/offline/OfflineMapView.tsx apps/web/src/lib/offlineAreas/styleAssets.ts apps/web/src/lib/offlineAreas/index.ts
git commit -m "feat: pin OpenMapX styles for offline packages"
~~~

### Task 11: Remove package lookup from the service-worker tile path

**Files:**

- Create: apps/web/src/lib/offlineAreas/packageWorkerMessages.ts
- Create: apps/web/src/lib/offlineAreas/packageWorkerMessages.test.ts
- Modify: apps/web/src/sw.ts, apps/web/src/lib/swCaches.ts, apps/web/src/lib/swCaches.test.ts, apps/web/src/lib/swAutoUpdate.ts

**Interfaces:**

- Consumes: page-side protocol from Task 9 and legacy cache functions from the current offline path.
- Produces: package-preserving service-worker activation and messages offline-package-ready, offline-package-error, offline-package-delete, and offline-legacy-area-found.

- [ ] **Step 1: Add failing service-worker regression tests.**

Test:

Required test cases:
- does not enumerate offline-area caches for a pmtiles tile request
- keeps ready package files when a service-worker cache version changes
- keeps legacy per-tile fallback during migration
- emits a package-ready message after page-side finalization
- does not delete package storage during activate

- [ ] **Step 2: Remove new-path matchOfflineArea scanning.**

Keep the legacy reader only behind an explicit migration path. Route normal
MapLibre package reads through the page-side protocol. Do not add a new
caches.keys() call to the tile handler. Preserve app-shell NetworkFirst and
small style/glyph/sprite runtime behavior.

- [ ] **Step 3: Add package lifecycle messages and update guards.**

Version messages, validate packageId, and make activation ignore OPFS/IDB package
files. A service-worker update may notify the page that a package manifest/style
is from an older app schema, but it must not silently remove a ready archive.

- [ ] **Step 4: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/swCaches.test.ts apps/web/src/lib/offlineAreas/packageWorkerMessages.test.ts
pnpm --filter web check-types
git add apps/web/src/sw.ts apps/web/src/lib/swCaches.ts apps/web/src/lib/swCaches.test.ts apps/web/src/lib/swAutoUpdate.ts apps/web/src/lib/offlineAreas/packageWorkerMessages.ts apps/web/src/lib/offlineAreas/packageWorkerMessages.test.ts
git commit -m "refactor: keep package storage out of service-worker lookup"
~~~

### Task 12: Rebuild offline settings around preparation, bytes, and verification

**Files:**

- Create: apps/web/src/app/settings/offline/OfflinePackageStatus.tsx
- Create: apps/web/src/app/settings/offline/OfflinePackageStatus.test.tsx
- Modify: apps/web/src/app/settings/offline/OfflineSettingsClient.tsx, AreaPickerMap.tsx
- Modify: packages/i18n/locales/en.json, packages/i18n/locales/de.json
- Modify: apps/web/src/lib/offlineAreas/index.ts

**Interfaces:**

- Consumes: package API/downloader/storage/resolver from Tasks 7–10.
- Produces: the existing area-picker flow backed by preparing → downloading → verifying → ready, exact byte progress, pause/resume/cancel/delete, quota errors, and provider capability messaging.

- [ ] **Step 1: Write failing component tests for every lifecycle state.**

Add tests named:

Required test cases:
- shows preparing without pretending to know transfer bytes
- shows manifest byteLength and storage requirement before download
- shows byte progress rather than tile-count progress
- shows verifying after the stream reaches byteLength
- does not show ready when style or checksum validation fails
- shows source max zoom and effective max zoom separately
- shows a typed unavailable message for unsupported provider capability
- keeps pause/resume/cancel/delete actions accessible

- [ ] **Step 2: Replace the fixed estimate path.**

Remove BYTES_PER_ASSET_ESTIMATE and the new-path use of TOO_MANY_TILES from
OfflineSettingsClient.tsx. Send selected bbox/min/max zoom to the package API,
render normalized/effective values, and use manifest.archive.byteLength as the
exact total. Retain any legacy estimate only in a clearly labeled migration
view.

- [ ] **Step 3: Add preparation polling and download controls.**

Create one active coordinator per package ID. Disable duplicate starts, persist
state on pause/cancel, resume from the verified prefix, and update the UI from
OfflinePackageDownloadProgress. Use requestPersistentStorage() in the explicit
download action and show navigator.storage.estimate() before a package that
exceeds the available quota estimate.

- [ ] **Step 4: Add exact translations and accessible progress semantics.**

Add messages for preparing, readyToDownload, downloading, verifying, paused,
ready, quotaError, checksumError, unsupportedProvider, areaNotDownloaded,
offlineReroutingUnavailable, and liveDataUnavailable. Use role progressbar,
aria-valuenow, aria-valuemax, and a live status for transitions. Run the locale
parity checker after updating all catalogs.

- [ ] **Step 5: Run tests, type-check, and commit.**

~~~bash
pnpm exec vitest run apps/web/src/app/settings/offline/OfflinePackageStatus.test.tsx
pnpm -C packages/i18n exec tsx scripts/check-translations.ts
pnpm --filter web check-types
git add apps/web/src/app/settings/offline/OfflinePackageStatus.tsx apps/web/src/app/settings/offline/OfflinePackageStatus.test.tsx apps/web/src/app/settings/offline/OfflineSettingsClient.tsx apps/web/src/app/settings/offline/AreaPickerMap.tsx apps/web/src/lib/offlineAreas/index.ts packages/i18n/locales/en.json packages/i18n/locales/de.json
git commit -m "feat: show measured offline package progress"
~~~

### Task 13: Migrate legacy per-tile areas without surprise deletion

**Files:**

- Create: apps/web/src/lib/offlineAreas/legacyAreaReader.ts
- Create: apps/web/src/lib/offlineAreas/legacyAreaReader.test.ts
- Create: apps/web/src/lib/offlineAreas/migrateLegacyAreas.ts
- Create: apps/web/src/lib/offlineAreas/migrateLegacyAreas.test.ts
- Modify: apps/web/src/lib/offlineAreas/storage.ts, index.ts, OfflineSettingsClient.tsx, apps/web/src/sw.ts

**Interfaces:**

- Consumes: existing offline-area-<id> Cache API records and the new package API/storage lifecycle.
- Produces: scanLegacyAreas(), legacyAreaStatus(area), replaceLegacyArea(area), and explicit cleanup after replacement.

- [ ] **Step 1: Write migration fixture tests.**

Use a fake Cache API containing style, glyph, sprite, TileJSON, and tile URLs.
Test:

Required test cases:
- detects a legacy ready area and labels it legacy
- offers the same bbox/zoom intent for a replacement package
- keeps the legacy cache after an interrupted replacement
- deletes the legacy cache only after package ready
- requires redownload when the legacy style/provider is incompatible
- does not infer new package readiness from tilesDone and tileCount

- [ ] **Step 2: Implement read-only legacy detection and rendering fallback.**

Read legacy metadata without modifying it. Mark a legacy area incompatible when
its saved style/provider is not OpenMapX-compatible with the current source.
Keep the old reader for one migration release so existing users do not lose a
working area during rollout.

- [ ] **Step 3: Implement replacement and explicit deletion ordering.**

Start a package request from saved bbox/min/max zoom, keep the legacy cache while
the package is preparing, downloading, or verifying, and delete the legacy
cache only after package status is ready. When the user explicitly deletes the
legacy area first, remove only that cache and metadata.

- [ ] **Step 4: Run focused tests and commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/legacyAreaReader.test.ts apps/web/src/lib/offlineAreas/migrateLegacyAreas.test.ts
pnpm --filter web check-types
git add apps/web/src/lib/offlineAreas/legacyAreaReader.ts apps/web/src/lib/offlineAreas/legacyAreaReader.test.ts apps/web/src/lib/offlineAreas/migrateLegacyAreas.ts apps/web/src/lib/offlineAreas/migrateLegacyAreas.test.ts apps/web/src/lib/offlineAreas/storage.ts apps/web/src/lib/offlineAreas/index.ts apps/web/src/app/settings/offline/OfflineSettingsClient.tsx apps/web/src/sw.ts
git commit -m "feat: migrate legacy offline areas safely"
~~~

### Task 14: Add package metrics, attribution, and user/operator documentation

**Files:**

- Create: apps/web/src/lib/offlineAreas/packageMetrics.ts
- Create: apps/web/src/lib/offlineAreas/packageMetrics.test.ts
- Create: docs/docs/features/offline-maps.md
- Modify: docs/docs/guides/map-tiles.md, docs/sidebars.ts
- Modify: services/data-manager/src/offline-packages/generator.ts and apps/api/src/routes/offline-packages.ts at the package status call sites created by Tasks 4–6

**Interfaces:**

- Consumes: lifecycle transitions from Tasks 4, 8, 12, and 13.
- Produces: privacy-safe metric events and documentation that accurately states provider, attribution, storage, package, and navigation boundaries.

- [ ] **Step 1: Write metric sanitization tests.**

Assert that metric payloads include package ID, status, dataset/style version,
duration, byte length, retry/error code, and browser capability, while excluding
raw bbox coordinates, route geometry, GPS coordinates, destination labels, and
user IDs.

- [ ] **Step 2: Implement lifecycle metric helpers.**

Emit preparation, download, resume, verify, quota, checksum, migration, and
cold-reload outcomes through the existing telemetry/logging abstraction. Keep
sampling/consent behavior aligned with existing app telemetry. Data-manager logs
may include package ID, status, duration, byte length, and source version; they
must not include raw bbox values.

- [ ] **Step 3: Write the offline guide and update map-tile documentation.**

Document OpenMapX default/style selection and the self-hosted production tile
path; MapTiler fallback behavior and why it is not packaged in version one;
package preparation versus transfer versus verification; OPFS/IndexedDB quota
and deletion behavior; OSM/OpenMapTiles attribution; offline map versus route
continuation versus rerouting/live-data limits; and operator source/build/
retention requirements.

Do not state that offline maps imply offline route planning.

- [ ] **Step 4: Run metric tests and docs/legal checks, then commit.**

~~~bash
pnpm exec vitest run apps/web/src/lib/offlineAreas/packageMetrics.test.ts
pnpm --dir docs build
pnpm check-legal-tables
pnpm check-legal-updated
git add apps/web/src/lib/offlineAreas/packageMetrics.ts apps/web/src/lib/offlineAreas/packageMetrics.test.ts docs/docs/features/offline-maps.md docs/docs/guides/map-tiles.md docs/sidebars.ts
git commit -m "docs: document offline package capability boundaries"
~~~

### Task 15: Run the complete package acceptance matrix and performance comparison

**Files:**

- Modify only focused tests or fixtures that fail because of an implementation defect; do not change unrelated source.
- Handoff artifact: package/request metrics and browser acceptance results attached to the implementation PR or issue, not committed archives.

**Interfaces:**

- Consumes: all package, API, browser, service-worker, settings, migration, and documentation deliverables from Tasks 1–14.
- Produces: a release decision with all required checks green, baseline/package measurements, and a rollback flag/configuration instruction.

- [ ] **Step 1: Run all focused tests.**

~~~bash
pnpm exec vitest run packages/core/src/offline/offlinePackage.test.ts
pnpm exec vitest run packages/cli/src/lib/tile-pmtiles.test.ts
pnpm exec vitest run services/data-manager/__tests__/offline-packages.test.ts services/data-manager/__tests__/offline-packages-api.test.ts
pnpm exec vitest run apps/api/src/routes/__tests__/offline-packages.test.ts
pnpm exec vitest run apps/web/src/lib/offlineAreas
pnpm exec vitest run apps/web/src/lib/swCaches.test.ts
pnpm exec vitest run apps/web/src/app/settings/offline/OfflinePackageStatus.test.tsx
~~~

- [ ] **Step 2: Run repository quality gates.**

~~~bash
pnpm lint
pnpm check-types
pnpm test
pnpm --dir docs build
~~~

- [ ] **Step 3: Run the browser cold-reload matrix.**

For a small package and one representative package, test in latest Chrome,
Firefox, and Safari:

| Scenario | Expected result |
| --- | --- |
| Prepare same request twice | One job/package identity and one published archive |
| Network drops during download | paused, verified prefix retained, resume uses matching range/ETag |
| ETag changes | Partial bytes are rejected/restarted; an older ready package remains valid |
| Network disabled after ready and page reloads | App shell, style, glyphs, sprites, vector tiles, and attribution render without archive/network fetch |
| Light/dark switch offline | Same package archive serves both pinned styles |
| Overlapping packages | Deterministic package selection without Cache API enumeration |
| Request above source maxzoom | Effective source maxzoom shown; no false higher-detail download |
| Unsupported MapTiler-only deployment | Typed package-unavailable state; no packaging attempt |
| Legacy area present | Legacy remains usable or is offered a replacement; no surprise deletion |
| Storage pressure | New download fails recoverably; ready packages remain selectable |

- [ ] **Step 4: Compare current and package acquisition on the same inputs.**

Record current asset request count/bytes/wall time and package preparation
time/request count/bytes/transfer time/storage usage for the same bbox and zoom
range. The package path passes only when transfer is primarily governed by
measured package bytes and link throughput rather than thousands of request
turns, and a representative package near 20 MB no longer exhibits the original
multi-minute request queue on the same network profile.

- [ ] **Step 5: Verify rollback behavior.**

Disable the package feature flag and confirm that ready package files remain
untouched, old legacy readers still serve existing areas, and no new package is
reported ready by the disabled UI. Re-enable only after the failing acceptance
case is fixed.

- [ ] **Step 6: Write the acceptance handoff without broad staging.**

When all checks pass, attach the metrics and browser matrix to the
implementation handoff. When a check fails, return to the task owning that
behavior and use that task's focused commit command; do not create a broad
acceptance commit that stages entire directories.

The handoff must include the metrics table, browser versions, source dataset
version, package/style versions, exact test commands, known limitations, and
the explicit statement that offline routing/rerouting is not implemented by
this plan.

## Plan A done criteria

- [ ] A self-hosted OpenMapX MBTiles source produces a validated PMTiles area package.
- [ ] Package identity includes dataset, style/schema, coverage, zoom, and generator versions.
- [ ] Identical requests are canonical/idempotent and share one bounded job.
- [ ] The manifest exposes exact bytes, SHA-256, ETag, bounds, zooms, versions, style assets, and attribution.
- [ ] Full and resumed range downloads stream without API buffering or arbitrary file access.
- [ ] Browser metadata uses IndexedDB and the archive uses OPFS or the tested complete-blob fallback.
- [ ] A checksum/style/PMTiles failure cannot become ready.
- [ ] MapLibre renders both OpenMapX themes from local package bytes after a cold offline reload.
- [ ] Package coverage selection is deterministic and does not scan all caches per tile.
- [ ] Existing per-tile areas migrate without surprise deletion.
- [ ] Settings show preparation, exact bytes, verification, quota/error states, and source maxzoom semantics.
- [ ] OSM/OpenMapTiles attribution and provider/licensing boundaries are documented.
- [ ] Focused tests, repository checks, docs/legal checks, and browser/performance matrix pass.

## Stop conditions and rollback

Stop immediately and report the first failing condition if:

- PMTiles extraction cannot prove bbox/zoom correctness;
- the local reader cannot read OPFS/fallback bytes in supported browsers;
- MapLibre makes a network request for a nominally local package tile;
- an ETag/hash mismatch can append incompatible bytes;
- a partial or style-incomplete archive can become ready;
- the public API buffers the complete archive or exposes paths;
- service-worker activation can delete ready package files; or
- package source is MapTiler fallback data rather than self-hosted OpenMapX data.

Rollback is feature-flag based: disable package acquisition/protocol selection,
leave ready package files in place, retain the legacy reader for existing areas,
and correct the failing layer. Do not delete package data as part of a code
rollback.
