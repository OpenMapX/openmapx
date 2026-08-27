---
title: Data-source integrations
description: Writing a mobility data-source provider — the MobilityDataSourceProvider contract, multi-source merging, and how attribution and freshness reach the map.
sidebar_position: 6
---

# Data-source integrations

A **data-source integration** plots live points of interest on the map: EV
chargers colored by availability, fuel stations with per-grade prices, parking
with free-space counts, shared bikes and scooters, car-sharing vehicles, and
traffic webcams. From the user's side these are described in
[Mobility & live data](../features/mobility-data.md); this page is the code-side
contract for building one.

Every such integration declares the `data-source` domain and registers one
`MobilityDataSourceProvider`. The shared generic `data-source` integration owns
the orchestration, the HTTP routes, and the frontend layer that turns provider
output into markers — so a new category is a small integration that answers four
questions about a map viewport, and inherits consistent rendering, caching, and
attribution for free. If you have not read the
[integration system](./integration-system.md) reference yet, start there: it
covers the manifest, the `IntegrationContext`, and the loader lifecycle this page
builds on. For the end-to-end mechanics of a manifest and `setup(ctx)`, see
[Writing an integration](./writing-an-integration.md).

## What a data-source provider is

The `data-source` domain orchestrator is **merge-all**. When a user switches on a
category, the orchestrator finds the provider for it, queries the visible
bounding box, and renders the returned points; for categories that aggregate
several upstream feeds, the *provider itself* fans out to those feeds in parallel
and merges them into one set. There is no priority ranking between providers of
different categories — each category is its own provider, selected by id.

A provider answers four kinds of question for a viewport:

- **Search** — given a bounding box and any active filters, return the points to
  plot.
- **Detail** — given one point's id, return the rich content for the place panel.
- **Filters** — describe the filter controls to offer (connector type, fuel
  grade, available-only, and so on).
- **Map context** *(optional)* — return shaded zones that belong with the
  points, such as a scooter operator's no-parking areas.

Search and detail return their payload wrapped in a `MobilityResult<T>`, so
**attribution and freshness travel with every response** and reach the UI without
the provider wiring them through by hand.

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

  getFilters(): Promise<DataSourceFilterDef[]>;
  search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>>;
  getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>>;
  getMapContext?(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
    options?: DataSourceMapContextSelection,
  ): Promise<MobilityResult<DataSourceMapContext | null>>;
}
```

A few things to note up front:

- `id` is the stable provider id (`"fuel"`, `"ev-charging"`). It must match the
  manifest's `frontend.searchCategory.id` so the orchestrator can connect the
  category chip to the provider.
- `attribution` is the integration-level credit list — typically derived from the
  manifest rather than hand-written (see [Attribution](#attribution-and-freshness)).
- `bbox` is a `BoundingBox` object `{ south, west, north, east }` (not a tuple),
  re-exported from `@openmapx/core` along with the `DataSource*` result types.
- `filters` is an open `Record<string, unknown>` — the active filter values
  keyed by the filter ids from `getFilters()`. There is no dedicated filter type.

### `meta` — how points render

`DataSourceMeta` is static rendering and place-panel configuration the frontend
reads once. The orchestrator returns it alongside the filter list when the web
app enumerates available sources:

```ts
export interface DataSourceMeta {
  minZoom: number;                  // below this zoom the layer is hidden
  markerStyle: DataSourceMarkerStyle;
  placeCategory: string;            // panel heading, e.g. "Gas Station"
  placeCategoryRaw: string;         // raw category, e.g. "fuel"
  osmFilters?: OsmFilter[];         // OSM tags to snap a clicked point to a POI
  showResultsList?: boolean;        // show result cards under the filters
}
```

`markerStyle` picks between two render modes: `type: "circle"` (the default)
colors a dot per result `variant` using `variantColors`; `type: "icon"` draws an
SVG glyph from `iconPath` with a text label. `osmFilters` lets the place resolver
enrich a clicked fixed installation by snapping to the matching OpenStreetMap node
instead of a plain reverse-geocode — omit it for sources with no reliable OSM
equivalent (webcams, free-floating scooters).

### Result and detail shapes

`search` returns a list of `DataSourceResult` — the lightweight shape that becomes
a marker:

```ts
export interface DataSourceResult {
  id: string;                 // globally unique; usually "<sourceId>/<upstreamId>"
  name: string;
  coordinates: LngLat;        // [lng, lat]
  source: string;             // the contributing sourceId, for attribution
  sources?: string[];         // all sources when a point merges several feeds
  variant: string;            // drives marker color (e.g. "fast", "unknown")
  status?: string;            // "operational" | "non-operational" | …
  summary?: I18nToken;        // short localized label under the marker
  operator?: string;
  kind?: "station" | "vehicle";   // fixed vs free-floating; gates OSM snapping
  attributions?: DataSourceAttribution[]; // per-record runtime credit
  sortValues?: Record<string, number>;    // for client-side sorting
}
```

The `source` (or `sources`) field is load-bearing: it names which manifest
`dataSource` credited *this* point, which is how the per-view attribution strip
shows only the feeds that actually contributed.

`getDetail` returns the richer `DataSourceDetail`, which drives the place panel:
an address, an operator, opening hours, structured `sections` (tables, pricing
plans, images, embeds), and optional `parkAndRide` and `identity` hints. The full
field list is in the contract file; the key points are that section labels use
`I18nToken`s (raw strings on a label cell are a compile error, which keeps
un-translated text off the wire) and that `providerId` should be stamped so the
client resolves those tokens against the right integration's string catalog.

## A worked example

The `fuel` integration is a compact, complete data source. Its `index.ts` wires
the provider into the context:

```ts
import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setDeTankerkoenigApiKey, setFuelLogger } from "./providers/factory.js";
import { fuelProvider, setManifestDataSources } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setFuelLogger(ctx.log);
  setDeTankerkoenigApiKey(ctx.config["de-tankerkoenig-api-key"] as string | undefined);

  // Load attribution from the manifest *before* registering the provider,
  // so its `attribution` getter has data when the framework reads it.
  setManifestDataSources(ctx.manifest.dataSources ?? []);
  ctx.registerMobilityDataSource(fuelProvider);
  registerPlaceResolver(fuelProvider.id, createDataSourceResolver(fuelProvider));
}
```

Two registrations happen here. `ctx.registerMobilityDataSource` adds the provider
to the `data-source` domain list (the typed registrar described in the
[integration system](./integration-system.md#registering-capabilities)).
`registerPlaceResolver` plugs the provider into the place-id system so that
clicking a marker resolves to a full place card — `createDataSourceResolver`
wraps the provider's `getDetail` for that.

The provider itself implements the contract. Trimmed to the load-bearing parts:

```ts
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { type MobilityResult, withAttribution } from "@openmapx/mobility-core/result";
import { createManifestAttribution } from "@openmapx/integration-framework";

// Manifest-driven attribution store, populated in setup() above.
const attribution = createManifestAttribution();
export const setManifestDataSources = attribution.set;

class FuelDataSourceProvider implements MobilityDataSourceProvider {
  readonly id = "fuel";
  readonly meta = META;              // minZoom, icon markerStyle, placeCategory…
  readonly searchCacheTtl = 120;
  readonly detailCacheTtl = 120;

  // Mirrors what the provider attaches to each result.
  get attribution(): Attribution[] {
    return attribution.all();
  }

  async getFilters(): Promise<DataSourceFilterDef[]> {
    return [{ id: "fuelType", label: "Fuel Type", type: "multi-select", options: [/* … */] }];
  }

  async search(
    bbox: BoundingBox,
    filters?: Record<string, unknown>,
  ): Promise<MobilityResult<DataSourceResult[]>> {
    // Country-specific price feed if one covers the bbox; else OSM locations.
    const stations = await searchFuelStations(bbox);
    const results = (stations ?? await searchByCategory(CATEGORY_FILTERS.fuel, bbox))
      .map(mapToResult);

    return withAttribution(
      results,
      attribution.forResults(results),    // credit only the sources present
      freshnessNow({ hasRealtimeData: false }),
    );
  }

  async getDetail(itemId: string): Promise<MobilityResult<DataSourceDetail | null>> {
    const detail = await this.fetchDetail(itemId);
    const attr = attribution.bySource(extractSourcePrefix(detail?.id ?? ""));
    return withAttribution(detail, attr ? [attr] : [], freshnessNow());
  }
}

export const fuelProvider = new FuelDataSourceProvider();
```

The provider returns plain OpenStreetMap locations where no national price feed
reaches and switches to the country feed where one does — which is the simplest
form of multi-source behavior. `getFilters` declares a single `fuelType`
multi-select that the orchestrator caches and the frontend renders into the
filter panel.

## Multi-source merging

A category that aggregates many feeds does the fan-out inside `search`. The
`ev-charging` provider is the reference: it queries every registered upstream in
parallel with `Promise.allSettled`, flattens the results, deduplicates stations
that several feeds publish, and maps the merged set:

```ts
async search(bbox, filters): Promise<MobilityResult<DataSourceResult[]>> {
  const settled = await Promise.allSettled(
    EV_CHARGING_SOURCE_REGISTRY.map((s) => s.search(bbox, filters)),
  );
  const stations = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const merged = deduplicateChargingStations(stations);
  const results = merged.map(mapStationToResult);

  return wrapStatic(
    results,
    // A merged station can carry several `sources`; credit each one.
    attribution.forResults(results, (r) => r.sources ?? r.source),
  );
}
```

`Promise.allSettled` is deliberate: one failing or rate-limited upstream is
dropped rather than failing the whole search. Because each merged station records
every feed it drew from in `result.sources`, the second argument to
`forResults` returns the full list so the credit set covers all contributors. For
sharing categories that read GBFS, the
`@openmapx/mobility-core` GBFS client and `gbfs-provider-base` handle feed
discovery, fetching, and station-status normalization — build on those rather
than parsing GBFS by hand.

:::tip[Large datasets: ingest instead of fan-out]
When an upstream returns a whole national registry in one request (much of
parking, the big EV registries), prefer the **POI ingest pipeline** over an
eager per-request fetch: declare the feed with `ctx.registerPoiSources(...)` so
the `data-manager` service ingests it into PostGIS on a cron, and have `search`
read only the rows intersecting the viewport. See the
[service manifest](./service-manifest.md) for the data-manager side.

Both fixed `fetch.url` values and URLs returned by `resolveUrl` use the same
streaming safe downloader. It permits only public HTTP(S) endpoints on default
ports, follows at most five redirects, validates and DNS-pins every connection,
and rejects a hostname when any answer is private, loopback, link-local, or
reserved. The default total deadline is 60 seconds. `fetch.timeoutMs` may set a
source-specific deadline; `fetch.maxBytes` may raise or lower the 256 MiB
compressed-byte default but cannot exceed the 2 GiB hard maximum. Parser-specific
inflated and output limits still apply after acquisition.

If `headers` or `resolveHeaders` supplies any header, every redirect must retain
the exact scheme, hostname, and effective port. With no configured headers, URL
userinfo and nonstandard headers are stripped. Partial files are removed on
failure. Successful audit data is limited to the source kind, hostname, byte
count, duration, and SHA-256 digest; never put a full URL, query, or credential
in a source's own log messages.
:::

## Attribution and freshness

Both flow through the `MobilityResult<T>` envelope returned by every method:

```ts
export interface MobilityResult<T> {
  data: T;
  attributions: Attribution[];
  freshness: Freshness;
}
```

**Attribution.** Credit metadata lives in the manifest's `dataSources` array
(one entry per upstream feed, each with a stable `sourceId`, license, and privacy
fields). `createManifestAttribution()` turns that array into the canonical
`Attribution[]` shape, so the provider never hand-rolls credit literals. The
store gives you three readers:

- `all()` — every declared attribution, for the provider's `attribution` getter.
- `bySource(sourceId)` — one entry, for a detail response from a single feed.
- `forResults(results, sourcesFor?)` — the subset actually credited by a search
  response, deduped. It reads each result's `source` by default; pass a
  `sourcesFor` extractor (returning `result.sources`) when points merge several
  feeds.

Returning only the credited subset is what makes the map's attribution strip
show *just* the feeds visible right now — browsing fuel in one German city
credits Tankerkönig alone, not the whole European stack. The frontend layer
intersects the manifest's declared sources with the `sourceId`s in the response,
adds any per-record `result.attributions`, and feeds the result into the map's
attribution control, which appears while the layer is on and clears when it is
switched off.

**Freshness.** Every result carries a `Freshness` stamp:

```ts
export interface Freshness {
  fetchedAt: string;          // ISO 8601, always set
  dataAsOf?: string;          // upstream "valid as of" timestamp
  hasRealtimeData: boolean;   // drives the "live" badge in the UI
  isStale: boolean;
}
```

`freshnessNow({ hasRealtimeData })` builds one with `fetchedAt` set to now. Pass
`hasRealtimeData: true` when the upstream reports live status (free bikes, free
spaces, current price) so the UI can mark the data live; set `isStale: true` when
an ingested table has never been populated (cold start) or a realtime max-age
check tripped. When the upstream stamps its own timestamp, set `dataAsOf`
directly instead of using the factory.

## How a request flows

1. The user enables a category; the web app's `DataSourceLayer` reads the active
   source's `meta` (for `minZoom` and `markerStyle`), then queries the visible
   bbox through the generic `data-source` HTTP routes.
2. The orchestrator selects the provider by `id`, calls `search`, and caches the
   response in Redis keyed by the rounded bbox and a hash of the filters (TTL
   from the provider's `searchCacheTtl`, defaulting to the orchestrator's). A
   popular viewport is not re-fetched on every pan.
3. `DataSourceLayer` renders `data` as markers, and pushes the envelope's
   `attributions` into the map's attribution strip — filtered to the sources the
   response actually credited.
4. Panning shows a **Search this area** chip; the user refetches for the new
   viewport rather than reloading continuously.
5. Clicking a marker calls `getDetail`; the place resolver (registered in
   `setup`) turns it into a full place card with the same photo, knowledge, and
   review enrichment as any other place.

## Related pages

- [Mobility & live data](../features/mobility-data.md) — the user-facing feature
  and the full list of built-in sources.
- [Integration system](./integration-system.md) — the manifest, context,
  domains, and lifecycle this contract plugs into.
- [Writing an integration](./writing-an-integration.md) — the end-to-end
  walkthrough of building one.
- [Transit integrations](./transit-integrations.md) — the sibling contract for
  stops, departures, and trip planning.
- [Service manifest](./service-manifest.md) — backend services such as Overpass
  and the data-manager that data sources lean on.
