---
title: Data-source integrations
description: "Implement a mobility map category with MobilityDataSourceProvider, partial-result handling and captured attribution."
sidebar_position: 6
---

# Data-source integrations

A data-source integration supplies a map category such as EV charging, fuel,
parking, shared mobility or webcams. It implements `MobilityDataSourceProvider`
and registers through `ctx.registerMobilityDataSource` in the `data-source`
domain. The generic `data-source` integration provides HTTP routes and the web
layer that renders its results.

Read the [integration system](./integration-system.md) for manifests and host
lifecycle, then [Writing an integration](./writing-an-integration.md) for the
in-tree setup workflow. This runtime contract is for trusted built-ins;
installed declarative artifacts cannot register providers. The user-facing
categories are listed in [Mobility & live data](../features/mobility-data.md).

## What a data-source provider is

The generic orchestrator selects one category provider by ID. When a user
enables that category, its provider searches the requested bounding box. A
category that aggregates upstreams performs the fan-out inside its own provider.
There is no fallback or priority ranking between different categories.

A provider answers four kinds of question for a viewport:

- **Search**: given a bounding box and any active filters, return the points to
  plot.
- **Detail**: given one point's id, return the rich content for the place panel.
- **Filters**: describe the filter controls to offer (connector type, fuel
  grade, available-only, and so on).
- **Map context** _(optional)_: return shaded zones that belong with the
  points, such as a scooter operator's no-parking areas.

Search and detail return their payload wrapped in a `MobilityResult<T>`, so
attribution and freshness travel with each response. The provider must still
capture per-record receipts and preserve them through mapping.

## The contract

The interface lives in
`packages/integration-framework/src/contracts/mobility-data-source-provider.ts`.
A provider is an object with a few readonly descriptors and four methods:

```ts
export interface MobilityDataSourceProvider {
  readonly id: string;
  readonly meta: DataSourceMeta;
  readonly attribution: Attribution[];

  // Per-method cache TTLs (seconds); orchestrator defaults apply when unset.
  readonly searchCacheTtl?: number;
  readonly detailCacheTtl?: number;
  readonly mapContextCacheTtl?: number;
  readonly serviceIds?: string[];
  readonly coverage?: { countries?: string[]; bbox?: [number, number, number, number] };

  isAvailable?(): boolean;
  getFilters(): Promise<DataSourceFilterDef[]>;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<DataSourceSearchResult>;
  getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>>;
  getMapContext?(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
    options?: DataSourceMapContextSelection,
  ): Promise<MobilityResult<DataSourceMapContext | null>>;
}

// MobilityResult<DataSourceResult[]> plus why it may lack results, if it may.
interface DataSourceSearchResult extends MobilityResult<DataSourceResult[]> {
  partial?: "area" | "unavailable";
}
```

Observe these constraints:

- `isAvailable()` is asked every time the sources are listed. A source that
  answers `false` is left out of the list, so the web app offers no chip or
  search category for it; absent means always available. The `fuel` source
  uses it to stay hidden while no `fuel-stations` provider is registered.
- A search answer with `partial` set may lack results, and says why:
  - `"area"`: a source fetched only part of the view (it covered only some of
    its cells, ran out of time or requests, or the answer was cut at a cap). A
    narrower view or a later read holds more.
  - `"unavailable"`: a source did not answer, or is not ready yet. Zooming in
    does not help.

  Leave `partial` out of a complete answer. When an answer is partial for both
  reasons, send `"area"`. The route never caches a partial answer, sends it
  with `Cache-Control: no-store` and passes `partial` to the client. The client
  treats it as stale at once and asks again every 5 seconds, at most three
  times, while the view stays put. Only for `"area"` does the list suggest
  zooming in.

- `id` is the stable provider ID (`"fuel"`, `"ev-charging"`). Keep it aligned
  with the integration manifest ID and `frontend.searchCategory.id`. Listing
  uses the manifest ID, while search/detail resolve the provider ID.
- `attribution` is the integration-level credit list: typically derived from the
  manifest rather than hand-written (see [Attribution](#attribution-and-freshness)).
- `bbox` is a `BoundingBox` object `{ south, west, north, east }` (not a tuple),
  re-exported from `@openmapx/core` along with the `DataSource*` result types.
- `filters` is an open `Record<string, unknown>`: the active filter values
  keyed by the filter ids from `getFilters()`. There is no dedicated filter type.

### `meta` — how points render

`DataSourceMeta` is static rendering and place-panel configuration the frontend
reads once. The orchestrator returns it alongside the filter list when the web
app enumerates available sources:

```ts
export interface DataSourceMeta {
  minZoom: number; // below this zoom the layer is hidden
  markerStyle: DataSourceMarkerStyle;
  placeCategory: string; // panel heading, e.g. "Gas Station"
  placeCategoryRaw: string; // raw category, e.g. "fuel"
  osmFilters?: OsmFilter[]; // OSM tags to snap a clicked point to a POI
  showResultsList?: boolean; // show result cards under the filters
}
```

`markerStyle` picks between two render modes: `type: "circle"` (the default)
colors a dot per result `variant` using `variantColors`; `type: "icon"` draws an
SVG glyph from `iconPath` with a text label. `osmFilters` lets the place resolver
enrich a clicked fixed installation by snapping to the matching OpenStreetMap node
instead of a plain reverse-geocode. Omit it for sources with no reliable OSM
equivalent (webcams, free-floating scooters).

### Result and detail shapes

`search` returns lightweight `DataSourceResult` records for markers:

```ts
export interface DataSourceResult {
  contributors?: readonly Attribution[]; // acquisition-time record receipt
  fieldContributors?: FieldContributors; // ownership of mixed displayed fields
  id: string; // globally unique; usually "<sourceId>/<upstreamId>"
  name: string;
  coordinates: LngLat; // [lng, lat]
  source: string; // the contributing sourceId, for attribution
  sources?: string[]; // all sources when a point merges several feeds
  variant: string; // drives marker color (e.g. "fast", "unknown")
  status?: string; // "operational" | "non-operational" | …
  summary?: I18nToken; // short localized label under the marker
  operator?: string;
  kind?: "station" | "vehicle"; // fixed vs free-floating; gates OSM snapping
  attributions?: Attribution[]; // legacy per-record compatibility credit
  sortValues?: Record<string, number>; // for client-side sorting
}
```

The `source` and `sources` fields identify suppliers for policy and adapter
resolution. Capture their metadata before acquisition and retain the resulting
`contributors`; IDs alone cannot reconstruct historical notices from a later
manifest. Mixed records also need field ownership so the rendered view can
project only the suppliers of displayed values.

`getDetail` returns the richer `DataSourceDetail`, which drives the place panel:
an address, an operator, opening hours, structured `sections` (tables, pricing
plans, images, embeds), and optional `parkAndRide` and `identity` hints. The full
field list is in the contract file; the key points are that section labels use
`I18nToken`s (raw strings on a label cell are a compile error, which keeps
un-translated text off the wire) and that `providerId` should be stamped so the
client resolves those tokens against the right integration's string catalog.

## A worked example

The `fuel` integration is a compact, complete data source. It fetches nothing
itself: it orchestrates every enabled integration that registers a
`FuelStationProvider` (domain `fuel-stations`) through
`ctx.registerFuelStationProvider`. Its `index.ts` wires the data source into the
context:

```ts
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createFuelDataSource } from "./data-source.js";

export function setup(ctx: IntegrationContext): void {
  const source = createFuelDataSource(ctx);
  ctx.registerMobilityDataSource(source);
  registerPlaceResolver(source.id, createDataSourceResolver(source));
}
```

Two registrations happen here. `ctx.registerMobilityDataSource` adds the provider
to the `data-source` domain list (the typed registrar described in the
[integration system](./integration-system.md#registering-capabilities)).
`registerPlaceResolver` plugs the provider into the place-id system so that
clicking a marker resolves to a full place card: `createDataSourceResolver`
wraps the provider's `getDetail` for that.

The provider uses `wrapSiteResult` (aliased as `wrap`), `siteAttributions`,
`toBBox` and `withinZoom` from `@openmapx/integration-framework`. This excerpt
shows its search/detail methods; the complete implementation is
`integrations/fuel/data-source.ts`:

```ts
// Inside createFuelDataSource; stations, requestedGrades, sells, hasPrice,
// META and the mappers are local to integrations/fuel/data-source.ts.
const methods: Pick<MobilityDataSourceProvider, "search" | "getDetail"> = {
  async search(bbox, filters) {
    if (!withinZoom(bbox, META.minZoom)) return wrap([], []);
    const grades = requestedGrades(filters);
    const pricesOnly = filters?.pricesOnly === true;
    const query = {
      ...(pricesOnly ? { pricesOnly } : {}),
      ...(grades.length > 0 ? { grades } : {}),
    };
    const found = await stations.search(toBBox(bbox), query);
    const kept = found.sites.filter(
      (s) => (grades.length === 0 || sells(s, grades)) && (!pricesOnly || hasPrice(s)),
    );
    const result = wrap(kept.map(mapFuelStationToResult), siteAttributions(kept));
    return found.partial ? { ...result, partial: found.partial } : result;
  },

  async getDetail(itemId) {
    const station = await stations.find(itemId);
    if (!station) return wrap(null, []);
    return wrap(mapFuelStationToDetail(station), station.attributions);
  },
};
```

The data source concatenates providers' stations in registration order. Each
provider deduplicates its own results. The category reapplies `fuelType` and
`pricesOnly` after acquisition, so a provider that ignores them cannot widen
the answer. `getFilters` declares a
`fuelType` multi-select. The generic source list calls `getFilters` on every
request, without a shared filter cache, so upgrades cannot retain obsolete
controls. A provider that acquires filters upstream owns its own cache.

Because `fuel` aggregates providers rather than reading feeds itself, its
manifest declares no `dataSources`. Credits come from each station's
canonical `contributors`, captured before cache/aggregation and preserved by
mapping. Older per-record `attributions` remain a compatibility format; do not
round-trip canonical receipts through their text-only shape (see
[Attribution and freshness](#attribution-and-freshness)).

## Multi-source merging

A category that aggregates many feeds does the fan-out inside `search`. The
`ev-charging`, `parking`, `fuel` and `webcam` providers are orchestrators over
typed site-provider contracts (`ChargingSiteProvider`, `ParkingSiteProvider`,
`FuelStationProvider`, `CameraProvider`). `createSiteOrchestrator` queries every registered
provider in parallel, tolerates failures, and merges what comes back, so the
data source only filters and maps the merged sites:

```ts
async search(bbox, filters) {
  const found = await sites.search(toBBox(bbox));
  const kept = found.sites.filter((s) => matches(s, filters));
  const result = wrapSiteResult(kept.map(mapChargingSiteToResult), siteAttributions(kept));
  return found.partial ? { ...result, partial: found.partial } : result;
}
```

When a provider fails or is rate-limited, the site orchestrator retains useful
results from the others and reports `partial`. The category must propagate that
reason, as the fuel example does, so the host does not cache an incomplete answer. Each
merged site carries the credits of every feed it drew from, and
`siteAttributions` returns the full list so the credit set covers all
contributors. For
sharing categories that read GBFS, the
`@openmapx/mobility-core` GBFS client and `gbfs-provider-base` handle feed
discovery, fetching, and station-status normalization: build on those rather
than parsing GBFS by hand.

:::tip[Large datasets belong in OpenConditions]
When an upstream returns a whole national registry in one request, do not fetch
it per request. Bulk sources are catalogued as feeds in OpenConditions, which
ingests and links them; read the result through the matching provider contract
(for example `charging-sites`) instead.
:::

Acquisition limits and safe downloading for those bulk feeds belong to
OpenConditions. The OpenMapX adapter consumes the resulting typed records; it
must still enforce accepted runtime sources, current source policy, pagination
limits and partial-result propagation. See [Runtime data sources](./integration-system.md#runtime-data-sources).

## Attribution and freshness

Both flow through the `MobilityResult<T>` envelope returned by every method:

```ts
export interface MobilityResult<T> {
  data: T;
  attributions: Attribution[];
  freshness: Freshness;
}
```

**Attribution.** Declare static source/privacy metadata in the manifest's
`dataSources`, with stable `sourceId` values and localized disclosures.
`createManifestAttribution()` supplies metadata lookup readers (`all`,
`bySource`, `forResults`); those readers do not establish that a configured feed
supplied visible data. Capture the exact supplier metadata before acquisition,
then retain canonical `contributors` on each station, vehicle, detail and map
context polygon. Shared-mobility parser child IDs require an explicitly proven
canonical parent source, including its mandatory notices.

Use `contributorsForRecords` from `@openmapx/integration-framework` for envelope
credits after filtering/deduplication. The mapper retains canonical receipts;
legacy `DataSourceResult.attributions` remain an explicit compatibility format.
A discarded duplicate owes no credit unless a field/identity was actually
merged. Canonical `[]` is authoritative. Missing mixed item provenance cannot
fall back to every declared source or a provider/domain catalogue.

`DataSourceLayer` publishes per-feature snapshots and registers the actual
rendered marker/logo/label/context geometry. A query-bbox response is not the
visible viewport; offscreen, filtered and hidden records do not credit their
supplier. Successful cached visible data keeps its acquisition-time receipt
through registry changes and failed refreshes. Detail panels own their selected
record's displayed-field credits independently of map visibility. See the
[captured contributor contract](./integration-system.md#captured-contributor-contract)
and [map contract](./integration-system.md#crediting-an-overlays-sources).

**Freshness.** Every result carries a `Freshness` stamp:

```ts
export interface Freshness {
  fetchedAt: string; // ISO 8601, always set
  dataAsOf?: string; // upstream "valid as of" timestamp
  hasRealtimeData: boolean; // drives the "live" badge in the UI
  isStale: boolean;
}
```

`freshnessNow({ hasRealtimeData })` builds one with `fetchedAt` set to now. Pass
`hasRealtimeData: true` when the upstream reports live status (free bikes, free
spaces, current price) so the UI can mark the data live; set `isStale: true` when
an ingested table has never been populated (cold start) or a realtime max-age
check tripped. When the upstream stamps its own timestamp, set `dataAsOf`
on the returned envelope, for example
`{ ...freshnessNow({ hasRealtimeData: true }), dataAsOf: upstreamTimestamp }`. Keep the
actual evidence time when serving stale/cached data; a new request time cannot
make old data fresh.

For transit departures, `dataAsOf` is when the upstream last updated the
realtime data. The web marks a board stale when the source was more than 90
seconds behind at `fetchedAt`; time the board then spends in caches or on screen
is not counted. A response's
generation time (for example SIRI `ResponseTimestamp`) or a static dataset's
publication time does not qualify. Transit providers built with
`defineTransitProvider` pass it as `wrapRT(data, sourceIds, { dataAsOf })`;
`upstreamDataAsOf` reads Unix-second or ISO stamps and leaves missing or future
ones unknown.

## How a request flows

1. The user enables a category; the web app's `DataSourceLayer` reads the active
   source's `meta` (for `minZoom` and `markerStyle`), then queries the visible
   bbox through the generic `data-source` HTTP routes.
2. The orchestrator selects the provider by `id`, calls `search`, and caches the
   response in Redis keyed by the rounded bbox and a hash of the filters (TTL
   from `searchCacheTtl`, default 21,600 seconds; detail defaults to the same
   lifetime and map context to 300 seconds). A
   popular viewport is not re-fetched on every pan.
3. `DataSourceLayer` publishes captured receipts with marker/logo/label/context
   features and projects the union of actual rendered contributions into the map
   credits strip. The envelope is not a substitute for individual ownership.
4. Panning shows a **Search this area** chip; the user refetches for the new
   viewport rather than reloading continuously.
5. Clicking a marker calls `getDetail`; the place resolver (registered in
   `setup`) turns it into a full place card with the same photo, knowledge, and
   review enrichment as any other place.

## Related pages

- [Mobility & live data](../features/mobility-data.md): the user-facing feature
  and the full list of built-in sources.
- [Integration system](./integration-system.md): the manifest, context,
  domains, and lifecycle this contract plugs into.
- [Writing an integration](./writing-an-integration.md): the end-to-end
  walkthrough of building one.
- [Transit integrations](./transit-integrations.md): the sibling contract for
  stops, departures, and trip planning.
- [Service manifest](./service-manifest.md): backend services such as Overpass
  and the data-manager that data sources lean on.

## Verify a category

Test search/detail mapping with synthetic or captured public fixtures, including
empty results, explicit empty receipts, mixed suppliers and partial failures.
Assert that partial reasons survive filtering and that `isAvailable` hides a
category with no backing providers. Verify both tuple and object bounding-box
boundaries; the typed site providers use `[west, south, east, north]`, while this
contract takes `{ south, west, north, east }`.

For visible changes, inspect the real rendered markers, filters, detail panel
and attribution after panning, filtering and refresh. A result envelope or a
successful HTTP fixture alone does not establish which features are visible.
