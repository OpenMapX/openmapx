# OpenMapX Offline Maps and Navigation Design Specification

> **Status:** Design approved at the approach level; written specification awaiting review
>
> **Implementation status:** No source implementation is authorized by this document. The follow-up implementation work is split into two plans in this same directory.
>
> **Baseline:** OpenMapX commit `a242b5a39faf045b23ab54bc0799bf71b35d00a2` (2026-08-03)

## 1. Executive decision

OpenMapX should remain online-first, but its primary offline acquisition path
should change from “request every tile and support asset individually” to
“download one immutable, versioned regional map package.”

The recommended package is a PMTiles v3 archive containing the configured
self-hosted OpenMapX vector tiles for a canonical rectangular area and zoom
range. The server produces and publishes the archive as an immutable artifact;
the browser downloads it as one resumable byte stream, stores it as a local
file, and exposes it to MapLibre through a local custom protocol. Package
metadata lives in IndexedDB and the archive itself lives in OPFS where
available, with a complete-blob fallback for browsers that cannot use OPFS.

Styles, glyphs, sprites, attribution, and dataset compatibility are versioned
alongside the package. A package is not selectable as `ready` until its archive
length, checksum, PMTiles metadata, style assets, and compatibility contract
have been verified.

Version one supports offline map rendering and degraded continuation of a
route that was planned while online. It does not ship a local routing graph or
promise new offline route planning, offline rerouting, live traffic, live
transit, or other network-backed data. Those capabilities remain explicit
follow-up projects.

The work is intentionally split into two implementation plans:

1. **Map packages:** package generation, manifest/API, browser storage and
   downloading, MapLibre integration, UX, migration, and observability.
2. **Navigation continuation:** persisted route sessions, offline guidance and
   reroute degradation, reconnect behavior, and navigation-specific tests.

The navigation plan depends on the package contract and client store from the
map-packages plan, but it must not expand that plan into a local routing-engine
project.

## 2. Product intent

OpenMapX is primarily an online map application. Online mode should continue to
provide the current broad coverage, live services, server-side routing, and
normal style behavior. Offline support should make a selected area dependable
when connectivity is absent or intermittent, without making the product look
like it has a complete offline replica of every online service.

The user should be able to keep the current mental model:

1. choose a rectangular area on the map;
2. choose a level of detail or zoom range;
3. see a trustworthy preparation result and package size;
4. download, pause, resume, retry, or delete the area;
5. reopen the app without a network; and
6. see the same OpenMapX map and theme inside the downloaded coverage.

The experience should feel like the online map inside the downloaded area,
with capability indicators making the boundary visible. It should not present
a stale live overlay or a route that silently depends on an unavailable API.

### 2.1 User stories

#### Offline map

- As a user, I select an area and detail level and get a measured package size
  before committing to a large download.
- As a user on a mobile or high-latency connection, I can download the area in
  one efficient transfer rather than waiting on thousands of small requests.
- As a user, I can close the tab, lose connectivity, reopen the app, and
  resume without losing a verified prefix of the package.
- As a user, I can disable the network and still render vector tiles, labels,
  light/dark styling, attribution, and the app shell for a downloaded area.
- As a user, I can keep several downloaded areas and get deterministic coverage
  when they overlap.
- As a user, I can tell the difference between preparing, downloading,
  verifying, ready, paused, and failed.

#### Offline navigation

- As a user, I plan a ground route while online, then lose connectivity and
  continue seeing the route, position, progress, and already-known guidance.
- As a user, I see clearly that a reroute cannot be calculated offline instead
  of receiving repeated failed network requests or an apparently current
  route.
- As a user, I can reconnect and deliberately request a fresh reroute.
- As a user, I can reload the app offline and be offered a valid active route
  session when its snapshot and map coverage are still available.

### 2.2 Non-goals for version one

- A local routing graph or a fully offline route planner.
- Arbitrary offline rerouting after the user leaves the planned route.
- Offline replicas of traffic, transit departures, weather, reviews, imagery,
  cameras, or other live overlays.
- Changing OpenMapX's default online basemap provider.
- Silently packaging MapTiler-hosted data under the OpenMapX provider name.
- Switching from vector tiles to a raster screenshot/tile bundle as the default
  map format.
- Route-corridor or polygon extraction before rectangular package behavior is
  measured and stable.

## 3. Findings from the current implementation

### 3.1 Provider and deployment facts

The provider naming needs to remain precise because it affects the package
source and licensing boundary.

- `apps/web/src/lib/env.ts:30-38` defaults `styleProvider` to `openmapx` when
  `NEXT_PUBLIC_STYLE_PROVIDER` is not set.
- `apps/web/src/lib/map.ts:150-176` loads the bundled OpenMapX light/dark
  style. When `env.tilesUrl` is configured, the style uses that tile source.
  When it is absent, the source is rewritten to the MapTiler API route and
  glyphs use the MapTiler proxy.
- Therefore, MapTiler Cloud is a fallback tile/font source for an otherwise
  OpenMapX-selected style in the current code path. It is not the default
  style-provider selection.
- The corrected documentation is in
  `docs/docs/guides/map-tiles.md:9-15,159-173`.
- The live `openmapx.com` instance inspected during the investigation selected
  `styleProvider: openmapx` and used same-origin `/tiles` endpoints. Its
  TileJSON exposed gzip-compressed same-origin PBF tiles from a
  Planetiler/OpenMapTiles MBTiles-backed TileServer GL deployment. The
  observed source advertised a Germany bounding box and `maxzoom: 14`.

The live values are operational data and must be rechecked at implementation
kickoff because a dataset refresh may change bounds, build timestamps, or
maximum zoom. The architectural fact is stable: the production default is
self-hosted OpenMapX data, not MapTiler Cloud.

### 3.2 Why a roughly 20 MB download can take roughly 10 minutes

The displayed byte total is not the dominant unit of work in the current
implementation. The downloader creates a large request queue:

- `apps/web/src/lib/offlineAreas/tiles.ts:18-47` enumerates every tile in an
  axis-aligned rectangle for every inclusive zoom level.
- `apps/web/src/lib/offlineAreas/styleAssets.ts:52-85` discovers TileJSON
  templates and adds support assets. It also adds five glyph ranges per font
  stack and four sprite variants.
- `apps/web/src/lib/offlineAreas/downloader.ts:72-108` expands every tile
  template for every coordinate and combines those URLs with styles,
  TileJSON, glyphs, and sprites.
- `apps/web/src/lib/offlineAreas/downloader.ts:11` limits the in-page path to
  six workers.
- `apps/web/src/lib/offlineAreas/downloader.ts:119-238` performs a separate
  cache lookup, HTTP fetch, response-size read, and cache write for each
  asset.
- `apps/web/src/lib/offlineAreas/backgroundDownload.ts:45-81` queues the same
  per-asset list when Background Fetch is available; it does not change the
  acquisition unit.

Consequently, elapsed time is closer to:

```text
request-queue time ≈ asset count × average round-trip/work time ÷ concurrency
total time ≈ request-queue time + transfer time + cache/storage overhead
```

For example, a queue of 2,560 assets at six workers requires 427 worker turns.
At one second of end-to-end work per asset, queue time alone is about seven
minutes; at 1.4 seconds it is about ten minutes. This is illustrative rather
than a measurement of one specific user download. It explains how a payload
near 20 MB can still have a multi-minute wall time: the system is paying
connection scheduling, TLS/proxy/server latency, response handling, and Cache
API work thousands of times.

The current size/progress display is also not authoritative:

- `apps/web/src/app/settings/offline/OfflineSettingsClient.tsx:70-77` allows
  zoom 0–18 and uses a fixed `8 KiB` per-asset estimate.
- `OfflineSettingsClient.tsx:525-530` estimates tile count multiplied by that
  fixed value.
- The Background Fetch path later replaces the tile count with the complete
  style-plus-asset URL count.
- The observed online source advertises `maxzoom: 14`, so UI values above that
  source maximum need overzoom or validation semantics rather than silent
  requests for nonexistent higher-detail data.

The current ETA is therefore an estimate of a guessed count, not a forecast
from an immutable artifact with a known byte length.

### 3.3 Storage and readiness weaknesses

- `apps/web/src/lib/offlineAreas/storage.ts:3-29` stores all area metadata in a
  single localStorage JSON array and rewrites that array repeatedly.
- The tile payload is one Cache API entry per URL under
  `offline-area-<id>`.
- `apps/web/src/sw.ts:130-138` scans all offline-area caches for each tile
  request, so lookup work grows with the number of saved areas.
- `apps/web/src/app/settings/offline/OfflineMapView.tsx:83-117` resolves the
  current environment style rather than binding rendering to the saved
  `styleKey`/dataset version.
- TileJSON failures and many asset failures are treated as non-fatal by the
  current downloader. An area can reach `ready` without a complete base map.
- A partial collection of individually cached URLs has no atomic “complete
  package” boundary and no authoritative checksum.

These weaknesses are coupled: even if the network transfer were faster, the
browser could still show an area as ready while it was incomplete or later
select a mutable style against an old tile set.

### 3.4 Navigation weaknesses

- `packages/core/src/hooks/useDirections.ts:83-101` and
  `packages/core/src/api/directions.ts:25-50` plan through the API.
- `apps/web/src/lib/navigation/useNavigationEngine.ts:192-232` asks the API to
  reroute when off-route. On failure it keeps the old route and emits a
  failure signal, which is a useful starting point but not a persisted offline
  session.
- `packages/core/src/stores/navigationStore.ts:84-135,227-240` keeps route,
  alternatives, waypoints, and options in memory; only voice/screen
  preferences are persisted.

Therefore, an online route can degrade gracefully for the lifetime of the
current page, but a reload or cold offline start cannot reliably resume it.
The correct first step is route-session persistence and honest degradation,
not immediately embedding a full routing engine.

### 3.5 Existing data pipeline seams

- `services/tileserver/service.json:1-33` runs TileServer GL over MBTiles,
  fonts, and styles and exposes `/tiles`.
- `services/tileserver/config/config.json:40-43` maps the `openmapx` dataset to
  `tiles.mbtiles`.
- `packages/cli/src/lib/tile-mbtiles.ts:7-105` invokes Planetiler and writes
  the OpenMapX MBTiles artifact.
- `services/data-manager/src/jobs/download-style.ts:60-84` rewrites styles
  to local MBTiles sources, glyphs, and sprites.

The missing capability is a browser-oriented immutable derivative and its
distribution contract. Replacing the existing online provider is not needed.

## 4. Design principles

1. **The package is the unit of truth.** The UI, storage layer, and renderer
   reason about one immutable artifact, not a best-effort set of URLs.
2. **Bytes and versions are explicit.** The manifest carries measured length,
   checksum, dataset version, style version, bounds, zooms, and attribution.
3. **Ready is atomic.** A partial or incompatible archive cannot be selected
   as a usable area.
4. **Online and offline share the data lineage.** The package comes from the
   same pinned OpenMapX self-hosted dataset used by the online map.
5. **The package is read-only.** A refresh creates a new immutable package;
   existing bytes are never mutated in place.
6. **The page owns random tile reads.** The service worker remains an app-shell
   and small-asset cache, not a database of thousands of tile URLs.
7. **Offline capabilities are honest.** Map rendering, route continuation,
   rerouting, and live overlays are separate capability states.
8. **Current UX evolves incrementally.** The area rectangle and detail choice
   stay recognizable while the download lifecycle becomes more truthful.
9. **Provider boundaries are visible.** The self-hosted OpenMapX package path
   and any future MapTiler package path require separate configuration and
   licensing decisions.

## 5. Proposed architecture

```text
OSM extract + OpenMapTiles profile
              │
              ▼
        Planetiler build
              │
              ├── regional MBTiles used by current online TileServer GL
              │
              └── immutable PMTiles source/derivative
                              │
             canonical bbox + zoom/profile request
                              │
                              ▼
                  bounded package extraction job
                              │
                              ▼
                manifest + immutable area.pmtiles
                              │ HTTP GET / Range
                              ▼
          browser OPFS archive + IndexedDB package metadata
                              │
                  MapLibre local custom protocol
                              ▼
                      existing online-first map

server route response ──► persisted route session ──► offline continuation
```

### 5.1 Server-side package generation

The source pipeline continues to build the OpenMapX MBTiles artifact from the
same Planetiler input/profile as the online service. A PMTiles derivative is
then produced from that pinned build. Converting the already-built MBTiles is
the initial preference because it keeps online and offline data lineage tied to
one artifact; direct Planetiler PMTiles output can be benchmarked later.

The package generator:

1. validates and canonicalizes the request;
2. resolves the dataset and style versions;
3. reuses an existing package for an identical content/request key;
4. creates or queues a bounded extraction job for a new key;
5. validates the extracted PMTiles header, metadata, bounds, zooms, byte length,
   hash, and attribution;
6. writes to a temporary path and atomically publishes the final immutable
   path; and
7. exposes a manifest only after publication succeeds.

Concurrent requests for one package key must share a job. Different keys must
be subject to bounded concurrency, disk quotas, and cleanup. An incomplete
`.part` file must never be returned by the catalog or archive endpoint.

The first package shape remains a rectangle because it matches the existing
selection UI. The manifest and reader should leave room for a future polygon
or route-corridor geometry without adding that complexity to version one.

### 5.2 Canonical request identity

The request key must include every value that can affect bytes or rendering:

- dataset ID and immutable dataset version;
- tile schema and package format version;
- canonical west, south, east, and north coordinates;
- minimum and maximum zoom;
- style provider/profile and style version;
- package-generation algorithm version; and
- any future geometry/profile discriminator.

Canonicalization must clamp latitude to Web Mercator limits, normalize
longitude/dateline behavior, normalize decimal precision, reject invalid or
unbounded rectangles, sort numeric zoom values, and clamp the package maximum
to the actual source maximum. The implementation must not pretend that z15–18
contains additional source data when the source maxzoom is 14; the UI can
explain overzooming separately.

### 5.3 Manifest contract

The exact property names can follow repository conventions, but the meanings
below are required:

```ts
interface OfflineMapPackageManifest {
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
    bbox: {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    minZoom: number;
    maxZoom: number;
    geometry?: GeoJSON.Geometry;
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
```

The manifest is immutable. A dataset refresh changes `dataset.version` and
produces new package IDs rather than changing the bytes behind an existing
URL. The server maps opaque package IDs to validated files; it must not accept
an arbitrary filesystem path or remote URL from the browser.

The package request endpoint may first return a preparation job. Its states
must distinguish:

- `preparing`: the server is building or validating the artifact;
- `ready-to-download`: an immutable manifest and measured byte length exist;
- `failed`: no usable artifact was published; and
- `expired`: a previously generated package is no longer retained.

The browser has a separate local lifecycle (`queued`, `downloading`, `paused`,
`verifying`, `ready`, `error`, `deleting`) so server preparation and client
transfer are not conflated.

### 5.4 Archive distribution

The archive endpoint must support:

- `HEAD` with stable `Content-Length`, `ETag`, content type, and
  `Accept-Ranges`;
- full `GET` for a fresh download;
- a single contiguous `Range` `GET` for resume;
- correct `206` and `Content-Range` responses;
- stable bytes for an immutable package URL; and
- streaming from disk without buffering the complete artifact in the API
  process.

The client resumes only when the ETag and package hash remain compatible. It
may resume from a contiguous verified prefix; it must not treat an arbitrary
unverified sparse file as complete. If the server version changes, the client
discards the partial artifact and starts from the new manifest.

### 5.5 Browser storage

Use two stores with distinct responsibilities:

| Store | Contents | Rationale |
| --- | --- | --- |
| IndexedDB | Manifest, local lifecycle, byte progress, package coverage index, dataset/style versions, errors, route snapshot | Structured asynchronous metadata and deterministic lookup |
| OPFS | Temporary partial archive and finalized immutable `.pmtiles` file | File-like storage and random reads without thousands of cache entries |

Request persistent storage before a large acquisition and use
`navigator.storage.estimate()` to display quota/required-space information.
Persistent-storage permission is best effort; quota errors remain explicit.

Browsers without usable OPFS need a complete-blob fallback behind the same
package-reader interface. The fallback may use IndexedDB or a single immutable
Cache API response if compatibility testing proves it reliable. It must not
fall back to the existing thousands-of-URLs approach.

The download lifecycle is:

1. fetch and validate the manifest against the requested canonical parameters;
2. create or reopen a temporary local file;
3. stream a full or range response into the file;
4. persist progress at bounded byte intervals rather than once per tile;
5. flush and close the temporary file;
6. verify exact length, SHA-256, PMTiles header/metadata, and style bundle;
7. atomically rename the archive into its final location; and
8. mark the metadata `ready` only after the rename succeeds.

Cancellation and deletion must release readers before removing files. If
cleanup fails, the user sees a recoverable storage error rather than a false
success. Partial artifacts are never offered to the renderer.

### 5.6 MapLibre integration

Register a `pmtiles` custom protocol once per MapLibre runtime. An opaque local
source such as `pmtiles://offline/<packageId>` resolves through the package
store to a local archive and returns tile bytes for MapLibre. The selected
OpenMapX light/dark style rewrites its vector source to this local protocol
when the camera is within compatible offline coverage.

The proof of concept must verify the exact PMTiles JavaScript API for an
OPFS-backed local source. If the chosen library only accepts remote URLs,
implement its random-read source interface over a local file rather than
letting a nominally local URL trigger an online request.

The resolver must:

- choose only a package whose coverage contains the tile/camera and whose
  dataset/style schema is compatible;
- prefer the most specific covering package, then the newest compatible
  dataset, then a deterministic package ID tie-breaker;
- use the normal online source outside downloaded coverage when network is
  available;
- surface an explicit missing-coverage state when offline; and
- refuse to merge incompatible OpenMapTiles schemas or style versions.

The package is style-independent: light and dark styles reuse the same tile
archive. Glyphs, sprites, and style JSON are separate immutable versioned
assets. A missing required style asset makes the package unavailable rather
than producing a misleading labels-missing ready state.

### 5.7 Service-worker boundary

The service worker remains responsible for:

- the app shell and offline entry point;
- small immutable style, sprite, and glyph assets;
- ordinary online runtime cache strategies; and
- cleanup/migration messages for legacy per-tile areas.

The service worker is not the package database. The page-side MapLibre protocol
reads the local archive directly. A package ID in the local protocol URL makes
selection explicit and avoids scanning every offline-area cache for every tile.

If a browser-specific MapLibre execution mode proves that a worker is needed,
add a narrow message-based archive reader. Do not reintroduce one Cache API key
per tile.

## 6. Offline navigation design

### 6.1 Capability boundary

Version one supports continuation of a route already received from the online
directions service. It does not calculate a new route without the network.

The UI must represent these capabilities separately:

| Capability | Online | Offline v1 |
| --- | --- | --- |
| Render downloaded vector map | Yes | Yes, within package coverage |
| Show planned route geometry | Yes | Yes, if persisted snapshot is valid |
| Position/progress against known route | Yes | Yes, subject to device/location APIs |
| Existing maneuver/voice cues | Yes | Yes, from the snapshot |
| New route planning | Yes | No |
| Off-route rerouting | Yes | No; retain old route and signal unavailable |
| Traffic/closures/live transit | Yes where configured | No; visibly stale/unavailable |

“Offline navigation” in product copy must mean route continuation unless a
future release ships and tests a local routing engine.

### 6.2 Persisted route session

Persist a schema-versioned session containing at least:

- route geometry and decoded route steps/maneuvers;
- selected route and alternatives when available;
- origin, destination, intermediate waypoints, and route mode;
- directions provider and route options;
- route fingerprint and response timestamp;
- selected package ID(s) or coverage compatibility information;
- last known progress checkpoint and map-match state that is safe to restore;
- voice/screen preferences; and
- a schema version and expiry/retention policy.

On reload, validate the snapshot before offering resume. A valid route with no
compatible offline basemap may still show the route line, but the UI must
distinguish “route line available” from “basemap coverage available.”

### 6.3 Offline reroute behavior

When the device is offline and the current position leaves the route:

- stop repeated network reroute attempts;
- set a durable `rerouteUnavailable` capability/state;
- retain the old route and known guidance without claiming it is recalculated;
- make the limitation visible in the navigation surface; and
- resume normal reroute behavior only after connectivity returns and a
  deliberate request or controlled single retry succeeds.

When network returns, a successful reroute replaces the old route atomically.
A failed reconnect attempt must not clear the degraded state.

### 6.4 Future routing-engine boundary

Fully offline routing would require distributing a local graph, choosing an
engine such as OSRM/Valhalla/GraphHopper or an equivalent implementation,
defining graph updates, browser CPU/memory budgets, routing profiles, and
additional licensing/data policy. It should be evaluated as a separate product
and architecture decision after map packages are stable.

## 7. UX and detail policy

### 7.1 Lifecycle presentation

The settings surface should show separate server and client phases:

1. **Preparing** — the server is generating or locating the package; no final
   byte size is shown yet.
2. **Ready to download** — measured size, coverage, zoom range, dataset/style
   version, and attribution are known.
3. **Downloading** — byte-based progress, speed, pause, cancel, and retry.
4. **Verifying** — transfer is complete but checksum/PMTiles/style validation
   is still running.
5. **Ready** — archive is finalized and selectable offline.
6. **Paused** — resumable partial state is retained.
7. **Failed** — actionable reason such as quota, network, server expiry,
   checksum, or incompatible style.
8. **Deleting** — file cleanup is in progress; the area is not selectable.

The old fixed `8 KiB` estimate must not be presented as authoritative. Before
the server manifest exists, the UI may show “calculating” or a clearly labeled
historical estimate. Once the manifest exists, its measured byte length is the
source of truth.

### 7.2 Area and zoom semantics

Keep the rectangular picker and explicit minimum/maximum zoom range for the
first release. Canonical package generation must use the dataset's actual
coverage and source maximum. If a user chooses a display zoom above the source
maximum, explain that the map is overzoomed rather than implying that more
source data was downloaded.

Avoid silently adding a world overview when the user selects a local area.
Named profiles such as “overview,” “local detail,” and “route corridor” can be
introduced later, but each must be based on measured package sizes and
coverage, not another hard-coded bytes-per-tile guess.

### 7.3 Multiple package selection

Index package bounds and compatibility in IndexedDB and load the index into
memory at map startup. For a tile request, select deterministically by:

1. compatible dataset/style/schema;
2. containing coverage;
3. most specific coverage;
4. newest compatible dataset; and
5. stable package ID tie-breaker.

If no package covers the visible map while offline, show the existing map
surface with a clear “area not downloaded” state and an action to return to
online mode or download coverage later.

## 8. Alternatives considered

| Approach | Benefits | Problems | Decision |
| --- | --- | --- | --- |
| Keep per-tile Cache API prefetch | Smallest code change; existing path | Request explosion, inaccurate bytes, partial-ready states, cache scans, weak cross-browser background support | Migration fallback only |
| ZIP of `z/x/y` files | One download; easy to explain server-side | Browser must unpack/index many files; custom lookup; poor tile-archive interoperability | Rejected unless PMTiles POC fails |
| Download MBTiles directly | Matches current server artifact | SQLite/WASM query stack and browser lifecycle; server-oriented container | Keep as server input |
| Regional PMTiles archive | One immutable artifact, range reads, browser reader, MapLibre protocol, good lineage | Requires extraction/publish job and local-file validation | **Chosen** |
| Raster screenshot/tile bundle | Simple rendering path | Larger at detail, fixed styling, no theme/vector flexibility, weaker map continuity | Rejected as default |
| Ship local routing graph now | Could enable full offline routes | Much larger data, CPU, update, licensing, and product scope | Deferred |

## 9. API and data-policy requirements

The exact route names should follow existing API conventions, but the package
service must provide these capabilities:

1. **Request/estimate:** accept canonical bbox, zoom range, and provider
   profile; return normalized parameters, source maximum, dataset version, and
   an existing manifest or preparation job.
2. **Job status:** return `preparing`, `ready-to-download`, `failed`, or
   `expired`, with measured bytes once ready. Requests for the same key are
   idempotent.
3. **Manifest:** return immutable archive URL, byte length, SHA-256, ETag,
   bounds, zoom range, source/style versions, and attribution.
4. **Archive:** provide `HEAD`, full `GET`, and single-range `GET` with correct
   range headers and stable immutable bytes.
5. **Cleanup:** expire unreferenced packages under a disk budget while keeping
   currently streamed files safe.

The service must validate all numeric values, cap area/zoom/package size, and
reject arbitrary paths, arbitrary remote URLs, unsupported providers, and
unbounded preparation requests. A MapTiler-only deployment must return an
explicit unsupported-offline-package response unless offline redistribution
has been separately approved by its terms.

OpenStreetMap attribution and OpenMapTiles attribution must be carried in the
manifest and retained in the offline map surface. Provider identity must not
be used as a substitute for license text.

## 10. Rollout and migration strategy

### Phase 0: proof of concept and decision gates

- Build a tiny fixture and one representative regional package.
- Validate MBTiles-to-PMTiles conversion/extraction and inspect headers,
  metadata, bounds, zooms, and tile coordinates.
- Exercise full, resumed, interrupted, invalid-range, and changed-ETag
  transfers.
- Read the archive from OPFS and fallback storage through the chosen PMTiles
  reader and render both OpenMapX style variants with network disabled.
- Measure the current and package paths for the same bbox and zoom range.
- Verify persisted route continuation and offline reroute signaling.

The decision must be revisited if the reader cannot work locally across the
supported browsers, if MapLibre silently falls back to the network, if
extraction bounds/zooms cannot be guaranteed, or if package preparation and
storage are measurably worse than the current path for target areas.

### Phase 1: package path behind a feature flag

Implement the package catalog/API, browser store, downloader, protocol, and
settings UX behind a controlled feature flag. Keep the legacy downloader
available for migration and rollback. Instrument package lifecycle, integrity,
quota, coverage, and offline cold-reload outcomes without logging raw user
locations or full bboxes in normal telemetry.

### Phase 2: migration and default selection

Detect legacy `offline-area-*` caches and offer a safe migration or re-download
path. Do not claim a legacy area is a verified package. Remove legacy caches
only after the new package is ready or the user explicitly deletes the old
area. Make package selection the default for supported self-hosted OpenMapX
deployments; retain a clearly labeled fallback only while migration is active.

### Phase 3: navigation continuation

Add route-session persistence and degraded offline behavior using the package
store's coverage/version contract. Validate reload, route resume, route line
visibility, guidance, off-route suppression, reconnect reroute, and stale-live
indicators.

### Phase 4: cleanup and future evaluation

After browser and production metrics meet acceptance thresholds, remove the
per-tile downloader and cache-scan path. Evaluate route-corridor packages,
polygon clipping, and a true offline routing graph separately.

## 11. Risks and mitigations

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| PMTiles extraction semantics are misunderstood | Missing or extra tiles in an area | Fixture plus representative-area coordinate checks and header validation |
| Local reader cannot use OPFS random reads | Offline map falls back to network or fails | Validate exact library API early; implement a local random-read adapter and complete-blob fallback |
| Browser quota/eviction | Download fails or disappears | Storage estimate, persistent-storage request, clear lifecycle errors, cleanup UI, re-download path |
| Mutable style/source URLs | Old package renders incorrectly after deploy | Pin style/dataset versions and immutable assets in the manifest |
| Range server/proxy misbehavior | Resume corrupts or restarts unexpectedly | Automated HEAD/full/range/ETag tests and contiguous-prefix verification |
| Package generation overload | Server disk/CPU exhaustion | Canonical keys, shared jobs, bounded concurrency, quotas, retention, metrics |
| Overlapping packages conflict | Incorrect or mixed map source | Compatibility filtering and deterministic coverage selection |
| Legacy cache migration is incomplete | False ready state or lost area | Keep legacy path until package verification; migration is explicit and recoverable |
| Users interpret continuation as rerouting | Unsafe expectation during travel | Capability-specific UI and repeated `rerouteUnavailable` state |
| MapTiler terms do not permit packaging | Licensing/compliance exposure | Self-hosted OpenMapX-only v1 and explicit provider/license gate |
| Offline route snapshot contains sensitive data | Privacy exposure in origin storage/telemetry | Local-only storage, schema/retention policy, no raw route/location telemetry |

## 12. Acceptance metrics

Measure a fixed representative area under at least two network profiles, both
before and after the package path:

- server preparation time separately from transfer time;
- exact package bytes versus displayed bytes;
- number of HTTP requests for fresh and resumed acquisition;
- effective transfer throughput and time-to-ready;
- local storage consumed and cleanup success;
- visible tile completeness at selected zooms with the network disabled;
- cold reload success without an archive/style/network request;
- persisted route resume success;
- off-route reroute suppression and reconnect success; and
- package-generation, checksum, quota, and abandoned-partial-file rates.

The target is not an arbitrary universal ten-second promise. The target is that
wall time is primarily explained by measured package bytes and link
throughput, rather than thousands of request round trips, and that a package
near 20 MB no longer requires a multi-minute request queue on a normal
broadband or mobile connection.

## 13. Implementation-plan boundaries

### Plan A — regional offline map packages

Planned file: `docs/plans/2026-08-03-offline-map-packages-implementation.md`

This plan owns the package format POC, build/extraction pipeline, manifest and
archive endpoints, browser OPFS/IndexedDB store, resumable downloader,
MapLibre protocol/style resolution, settings UX, service-worker boundary,
legacy migration, attribution, metrics, and cross-browser acceptance tests.

Its final contract must expose enough information for navigation to ask:

- which package covers a route;
- whether the package's dataset/style schema is compatible; and
- whether the map can be rendered offline after a reload.

### Plan B — offline navigation continuation

Planned file: `docs/plans/2026-08-03-offline-navigation-continuation-implementation.md`

This plan owns route-session serialization, persisted resume, route geometry and
guidance restoration, offline capability state, suppression of repeated
reroutes, reconnect behavior, stale-live indicators, and navigation tests. It
depends on Plan A's package metadata and coverage resolver but does not add a
local routing graph.

The two plans must not duplicate package storage or invent separate offline
coverage semantics.

## 14. Required proof-of-concept gates

Implementation must stop for review if any gate fails:

1. A small MBTiles fixture and one representative OpenMapX regional source can
   produce an inspected PMTiles archive with correct bounds, metadata, and
   zooms.
2. The extracted archive contains expected coordinates and no unsupported zoom
   data.
3. The archive endpoint passes full, range, resume, invalid-range, and
   immutable-ETag tests.
4. The local reader renders both OpenMapX style variants from OPFS/fallback
   storage with network disabled.
5. A package cannot become `ready` until hash, byte length, PMTiles metadata,
   style assets, and compatibility all pass.
6. The package path materially reduces acquisition request count and removes
   the per-tile request queue as the dominant time cost.
7. An online ground route survives reload/offline transition as a persisted
   continuation session, while offline rerouting is clearly unavailable.
8. Chrome, Firefox, and Safari latest supported versions pass the offline cold
   reload and storage lifecycle checks.

## 15. References

- [PMTiles concepts](https://docs.protomaps.com/pmtiles/) — single-file tile
  archives, HTTP Range reads, browser usage, and MBTiles comparison.
- [PMTiles v3 specification](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md)
  — archive headers, directories, metadata, bounds, zooms, and compression.
- [PMTiles JavaScript API](https://pmtiles.io/typedoc/index.html) — reader and
  MapLibre integration surface to validate in the POC.
- [Planetiler](https://github.com/onthegomap/planetiler) — current map-data
  build pipeline and tile artifact lineage.
- [MapLibre `addProtocol`](https://maplibre.org/maplibre-gl-js/docs/API/functions/addProtocol/)
  — custom protocol contract.
- [Background Fetch specification](https://wicg.github.io/background-fetch/)
  and [MDN Background Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API)
  — why Background Fetch remains optional.
- [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
  and [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
  — browser storage and quota constraints.
- [OpenStreetMap copyright](https://www.openstreetmap.org/copyright) and
  [OpenMapTiles license](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md)
  — attribution and redistribution requirements.

## 16. Review checklist

- [ ] The default-provider distinction is accurate: OpenMapX style/default
  selection, self-hosted OpenMapX tiles for the production instance, and
  MapTiler only as fallback.
- [ ] The ten-minute/20 MB diagnosis distinguishes request count and latency
  from payload bytes.
- [ ] The PMTiles package, manifest, range, integrity, style, storage, and
  readiness contracts are implementable without hidden assumptions.
- [ ] Offline map rendering is clearly separated from offline route planning,
  rerouting, and live data.
- [ ] The package plan and navigation plan have non-overlapping ownership and a
  precise dependency boundary.
- [ ] The POC gates, browser matrix, migration, rollback, attribution, and
  metrics are sufficient for an implementation decision.
