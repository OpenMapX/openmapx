---
title: Integration system
description: The manifest, the IntegrationContext, the typed provider contracts, domains, and the loader-to-host lifecycle that powers OpenMapX features.
sidebar_position: 3
---

# Integration system

An **integration** is an app-level feature, packaged so the platform can discover
it, configure it, wire it to the backends it needs, and load it at runtime
without code changes elsewhere. The geocoding orchestrator, the routing
orchestrator, every transit provider, the map overlays, external POI data
sources, photos, reviews, weather, and place enrichment are all integrations.

This page is the conceptual reference for that machinery: the manifest schema,
the `IntegrationContext` an integration runs against, the typed provider
contracts and the domains they live in, and the lifecycle that takes a directory
on disk to a live feature. If you have not yet met the
service / integration / capability model, read
[How it works](../overview/how-it-works.md) first — it frames where integrations
sit relative to backend services. The administrator's side of the same system —
configuring integrations, setting secrets, and binding capabilities — is covered
in [Integrations & bindings](../administration/integrations-administration.md).
This page complements it from the code side.

## Anatomy of an integration

An integration is a directory. Built-in integrations live under `integrations/`
and run directly from workspace TypeScript source; community integrations live
under `custom_integrations/` and run from prebuilt bundles (see
[Built-in versus community](#built-in-versus-community)). The host only requires
two things to be present:

- **`manifest.json`** — declarative metadata. Required. This is what the host
  discovers and validates; an integration with only a manifest and no code is a
  valid (if inert) integration.
- **`index.ts`** (or a built backend bundle) — the runtime entry point. Optional.
  It exports a `setup(ctx)` function that the host invokes once at load time,
  passing the [`IntegrationContext`](#the-integration-context). This is where an
  integration registers providers, routes, and lifecycle hooks.

Most integrations also ship `strings/<locale>.json` localization files and, when
they have a frontend, a map overlay. An overlay can be **declarative** (described
entirely in the manifest and drawn by the host — no shipped frontend code) or
**code** (MapLibre layer / legend / panel components the integration ships). Both
are covered in [Map overlays](#map-overlays).

A backend entry point is typically very small — it wires implementations into
the context and returns:

```ts
import type { IntegrationContext } from "@openmapx/integration-framework";

export function setup(ctx: IntegrationContext): void {
  ctx.registerWeatherProvider(openMeteoProvider);
}
```

## The manifest

The manifest is validated against a Zod schema in
`packages/integration-framework/src/manifest.ts`. The fields below are the ones
that matter for understanding the system; the schema is the source of truth for
the exhaustive list.

### Identity and classification

```ts
{
  id: string;            // lowercase, hyphen-separated — /^[a-z0-9][a-z0-9-]*$/
  name?: string;         // display name; falls back to id
  version?: string;
  description?: string;
  author?: string;
  license?: string;      // SPDX id of the integration's own code
  documentation?: string;
  platform?: string;     // minimum platform version, "major.minor"
  quality?: "built-in" | "community-verified" | "community";
}
```

The `id` is load-bearing: it names the integration's directory, its config cache
namespace, its environment-variable prefix, and its API route prefix
(`/api/integrations/<id>/...`). It is constrained to a safe slug because it is
also embedded as a string literal in generated community-bundle stubs.

### Domains

```ts
{
  domains: string[];     // required, at least one
}
```

`domains` is the integration's most important declaration. A **domain** is the
feature area an integration participates in — `routing`, `geocoding`, `transit`,
`weather`, `data-source`, and so on. Domains are the join key between
integrations and the orchestrators that consume them: a domain orchestrator asks
the host for every enabled integration in its domain and merges their providers.
The field is a free-form string array, so one integration can serve several
domains, and frontend-only conventions (for example `map-overlay` or
`street-view`, which have no backend registrar) are expressed the same way. The
domains that carry a typed provider contract are enumerated in
[Domains and provider contracts](#domains-and-provider-contracts).

### Wiring: dependencies and requirements

```ts
{
  dependencies?: string[];   // other integration ids that must load first
  requires?: Array<{ service?: string; capability?: string; optional?: boolean }>;
}
```

`dependencies` controls load order — the host topologically sorts integrations
so a dependency is set up before its dependents. `requires` declares the
**backend services** the integration needs. Each entry sets exactly one of
`service` (a specific service slug) or `capability` (any service that provides
that capability), and may be marked `optional`. How these resolve at load time is
described in [Capability requirement resolution](#capability-requirement-resolution).

### Frontend and backend surfaces

```ts
{
  frontend?: {
    mapLayer?: boolean;      // ships a code map-layer component
    legend?: boolean;        // ships a code legend component
    panel?: boolean;         // ships a code side-panel component
    searchCategory?: { id: string; label?: string; showInChipBar?: boolean; iconPath?: string };
    layerSelector?: { group: "map-details" | "map-tools" | "map-types"; labelKey: string; icon?: string; /* … */ };
    overlay?: {
      excludes?: string[];   // overlay ids this one is mutually exclusive with
      minZoom?: number;
      // Declarative overlay — when `source` is present the host draws it from the
      // manifest with no shipped code (see "Map overlays" below):
      source?: {
        kind: "geojson-bbox" | "geojson" | "vector";
        route?: string;                       // integration-relative, e.g. "/observations"
        bboxParam?: "bbox" | "wsen";          // how the viewport is passed (geojson-bbox)
        extraParams?: Record<string, string>;
        tiles?: string[];                     // vector tile URL templates
      };
      layers?: Array<{
        id: string;
        type: "circle" | "line" | "fill" | "symbol";
        paint?: object; layout?: object; filter?: unknown[];  // MapLibre Style-Spec
        interactive?: boolean;                // register for click popup + hover cursor
      }>;
      legend?: {
        kind: "categorical" | "ramp";
        title?: string; titleKey?: string;
        items?: Array<{ color: string; label?: string; labelKey?: string }>;  // categorical
        stops?: Array<{ value: number; color: string }>;                      // ramp
      };
      popup?: { titleField: string; rows?: Array<{ field: string; label?: string; format?: "text" | "number" | "date" }> };
    };
  };
  backend?: {
    routes?: boolean;        // registers routes via ctx.registerRoute
    cron?: string | null;    // cron expression for a periodic task
  };
}
```

`mapLayer` / `legend` / `panel` are advertisement flags for **code** components
the integration ships. `searchCategory` and `layerSelector` are pure
declarations the host renders (a search-bar category chip; a layer-selector
entry). `overlay` carries mutual-exclusion rules (`excludes`) and `minZoom`,
**and**, when it includes a `source`, a full **declarative overlay** the host
draws from the manifest with no shipped code. `backend.routes` signals that the
integration registers HTTP routes; `backend.cron` declares a recurring task. How
the two overlay paths render is detailed in [Map overlays](#map-overlays).

### Config schema

```ts
{
  configSchema?: Record<string, unknown>;   // JSON-Schema-shaped
}
```

`configSchema` is a JSON-Schema-like object describing the integration's
settings. The admin panel renders it as a form, and the host uses it to know
which keys exist, their defaults, and which are secrets. A property marked
`"x-openmapx-secret": true` is a credential: it is never shown in the config
form or in API responses and is set through the Credentials tab instead. The
layered resolution of these values — defaults, database, vault, `config.json`,
and environment — is the **config cascade** documented in full on the
[admin page](../administration/integrations-administration.md#the-config-cascade).
An integration that declares any secret field will refuse to load at startup
unless the vault key (`OPENMAPX_SECRETS_KEY`) is present, so a missing key is a
hard boot error rather than a silent degrade.

### Health checks

```ts
{
  healthCheck?: HealthCheck | HealthCheck[];
}

interface HealthCheck {
  name?: string;
  type: "http" | "ping" | "tcp" | "custom";
  url?: string;
  urlTemplate?: string;                       // ${configKey} placeholders
  headers?: Record<string, string>;
  requiredConfigKeys?: string[];              // unconfigured if any is unset
  category?: string;
}
```

A `healthCheck` makes the integration probeable. `urlTemplate` and `headers`
interpolate `${configKey}` placeholders resolved through the config cascade, so a
probe can carry an API key without hard-coding it. If a key listed in
`requiredConfigKeys` is unset, the probe reports **unconfigured** rather than
attempting the request — the difference between "not set up yet" and "broken."
An array of checks rolls up into one signal: all must pass. The states and how
they surface are described on the
[admin page](../administration/integrations-administration.md#integration-health).

### Data sources

```ts
{
  dataSources?: Array<{
    sourceId: string;                 // stable, globally unique
    name: string;
    url: string;
    license: string;
    licenseUrl?: string;
    attribution?: string;
    providerCountry: string;          // ISO country code
    providerPrivacyUrl: string;
    commercialUse?: "yes" | "no" | "conditional" | "unknown";
    endUserExposure?: "direct" | "mixed" | "proxied" | "server-only" | "build-time";
    personalData?: boolean;
    cookies?: boolean;
    dpaAvailable?: boolean;
    /* … */
  }>;
}
```

`dataSources` is one entry per upstream API or dataset the integration touches.
It is the single home for credit and privacy metadata: the legal pages
(`/privacy`, `/terms`) and the per-result attribution chips are generated from
these entries, and a host-side completeness gate blocks a commit if any
generated table cell would be empty. The `sourceId` is globally unique across all
integrations, which lets attribution be resolved by source no matter which
integration declared it. Provider code should not hand-roll `Attribution`
objects — the framework's `createManifestAttribution()` helper turns
`dataSources` into the canonical attribution shape so credit metadata lives only
in the manifest.

:::note[Source IDs connect manifests to results]
A provider tags each result with the `sourceId` it came from, and the host maps
that back to the manifest entry to render the right license. Keep `sourceId`
values stable; renaming one orphans existing attribution.
:::

## The integration context

When the host calls `setup(ctx)`, it passes an `IntegrationContext` — the
integration's entire interface to the platform. The integration never imports the
API server, the database driver, or Redis directly; it uses the context, which
the host backs with concrete implementations. The structural definition lives in
`packages/integration-framework/src/context.ts`.

### Identity and configuration

```ts
interface IntegrationContext {
  readonly id: string;
  readonly manifest: IntegrationManifest;     // the parsed manifest
  readonly config: Record<string, unknown>;   // resolved config (cascade applied)
  // …
}
```

`config` arrives fully resolved — every layer of the cascade has already been
applied, so the integration reads plain values and does not concern itself with
where they came from.

### Services available to integration code

```ts
interface IntegrationContext {
  readonly http: HttpClient;          // fetch wrapper with optional Redis caching
  readonly cache: CacheClient;        // namespaced KV (int:<id>:<key>) with withCache()
  readonly liveStore: LiveStoreClient; // shared, non-namespaced data-manager keyspace
  readonly db?: DatabaseClient;       // only when the manifest requires postgis
  readonly log: Logger;               // tagged structured logger
  readonly secrets: SecretsClient;    // decrypted vault access
  // …
}
```

- **`http`** is a small client over `fetch` that can transparently cache GET
  responses in Redis when the call opts in with a TTL.
- **`cache`** is a key-value store namespaced per integration (`int:<id>:<key>`),
  with a `withCache(key, ttl, fn)` read-through helper. Namespacing means one
  integration cannot collide with another's keys.
- **`liveStore`** is a deliberately *un-namespaced* reader for the shared
  `poi:live:<sourceId>` keyspace written by the data-manager's ingest pipeline.
  It is separate from `cache` precisely because the data-manager knows nothing
  about integration ids — prefixing here would miss every write.
- **`db`** is present only when the manifest requires the `postgis` service;
  otherwise it is `undefined`.
- **`log`** is a structured logger tagged with the integration id.
- **`secrets`** retrieves a decrypted credential from the vault.

A second tier of services is optional — present in production, absent in tests
and CLI scripts — and orchestrators treat absence as a benign no-op:

```ts
interface IntegrationContext {
  readonly attributionIndex?: AttributionIndexHandle;  // resolve sourceIds + MOTIS feeds
  readonly providerHealth?: ProviderHealthHandle;      // record latency/outcome; cooldowns
  readonly metricsRecorder?: MetricsRecorder;          // OpenTelemetry per-call counters
  // …
}
```

These let an orchestrator skip a provider that is in a failure cooldown, record
per-call latency and outcome, and resolve attribution rows — without the
framework taking a compile-time dependency on the API server (they are declared
as structural interfaces and injected by the host).

### Registering capabilities

The context exposes one typed registrar per provider contract. Each pushes the
provider onto the integration's per-domain provider list, where the matching
orchestrator picks it up at request time:

```ts
interface IntegrationContext {
  registerTransitProvider(p: TransitProvider): void;          // → "transit"
  registerRealtimeProvider(p: RealtimeProvider): void;        // → "live-transit"
  registerMobilityDataSource(p: MobilityDataSourceProvider): void; // → "data-source"
  registerWeatherProvider(p: WeatherProvider): void;          // → "weather"
  registerGeocodingProvider(p: GeocodingProvider): void;      // → "geocoding"
  registerRoutingProvider(p: RoutingProvider): void;          // → "routing"
  registerPhotoProvider(p: PhotoProvider): void;              // → "photos"
  registerReviewProvider(p: ReviewProvider): void;            // → "reviews"
  registerPoiSearchProvider(p: PoiSearchProvider): void;      // → "poi-search"
  registerKnowledgeProvider(p: KnowledgeProvider): void;      // → "knowledge"
  registerGtfsCatalogProvider(p: GtfsCatalogProvider): void;  // → "gtfs-catalog"

  registerPoiSources(sources: readonly PoiSource[]): void;    // → data-manager ingest
  registerRoute(method, path, handler, options?): void;       // → /api/integrations/<id>/…
  registerHealthCheck(fn: CustomHealthCheckFn): void;         // overrides manifest probe
}
```

The typed registrars enforce the contract shape at compile time, so the
orchestrator can dispatch on a declared capability rather than reflecting over
the object. `registerPoiSources` is different in kind: it forwards entries to the
shared POI-source registry that the data-manager ingest pipeline also reads, so
large bbox-queryable datasets are ingested once rather than fetched eagerly per
request. `registerRoute` mounts a route under the integration's prefix; passing
`{ requireAuth: true }` makes the host reject unauthenticated callers with 401
before the handler runs.

### Lifecycle, events, and discovery

```ts
interface IntegrationContext {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;
  onShutdown(cleanup: () => Promise<void>): void;
  getIntegrationsByDomain(domain: string): LoadedIntegration[];

  getRequiredService(key: string): { serviceId: string; url: string; enabled: boolean } | null;
  getDisallowedSourceIds?(): Promise<Set<string>>;
  getDisallowedIntegrationIds?(): Promise<Set<string>>;
}
```

`emit`/`on` are a lightweight event bus shared across integrations.
`onShutdown` registers cleanup run on reload and shutdown.
`getIntegrationsByDomain` lets an orchestrator enumerate its peers.
`getRequiredService(key)` is how an integration reads a resolved requirement at
runtime (see below). The two `getDisallowed*` resolvers expose the operator's
data-use policy: orchestrators skip providers whose source — or whole
integration — the policy disallows, and fall back to the next.

## Domains and provider contracts

For the data-rich domains, the framework defines an explicit TypeScript
interface — a **provider contract** — in
`packages/integration-framework/src/contracts/`. A provider implements the
interface; the domain orchestrator consumes the typed shape. The contracts in
the mobility domains return their data wrapped in a `MobilityResult<T>`, so
attribution and freshness flow through every call unmodified.

| Domain | Contract | What providers in it do |
| --- | --- | --- |
| `geocoding` | `GeocodingProvider` | Forward geocode, autocomplete, reverse geocode. |
| `routing` | `RoutingProvider` | Turn-by-turn directions, plus optional isochrones and map-matching. |
| `transit` | `TransitProvider` | Stops, departures/arrivals, routes, trip planning, vehicle positions, alerts. |
| `live-transit` | `RealtimeProvider` | Realtime overlays: vehicle positions, service alerts, trip-update deltas. |
| `data-source` | `MobilityDataSourceProvider` | External POI sources — bike/car/scooter sharing, parking, fuel, EV charging, webcams. |
| `weather` | `WeatherProvider` | Current conditions, hourly and daily forecasts. |
| `photos` | `PhotoProvider` | Place imagery, including fast OSM-tag-based hero lookups. |
| `reviews` | `ReviewProvider` | Fetch, aggregate, and submit place reviews. |
| `poi-search` | `PoiSearchProvider` | Category and free-text POI search within a bounding box. |
| `knowledge` | `KnowledgeProvider` | Place enrichment from reference sources. |
| `gtfs-catalog` | `GtfsCatalogProvider` | List GTFS feeds for the schedule-feed importer to ingest. |

A few patterns recur across the contracts and are worth calling out:

- **Capability self-description.** `TransitProvider` and `RealtimeProvider` carry
  a `capabilities` object declaring which optional methods they actually
  implement, plus `coverage` (a bounding box or `{ all: true }`) and a numeric
  `priority` (lower wins). The orchestrator reads these to route a request to the
  right provider instead of probing methods at runtime.
- **Optional methods.** Most contract methods are optional; a provider implements
  only what it supports, and the capability object (or simple presence) tells the
  orchestrator what is available.
- **Attribution on the provider.** Mobility contracts expose `attribution`
  directly, and transit additionally offers `getFeedAttribution()` for
  integrations that front many feeds, each with its own license.

Domains without a typed contract — frontend-only conventions such as
`map-overlay` or `street-view` — still appear in `domains`, but they contribute
UI surfaces and routes rather than a registered provider object.

The per-contract authoring guides live alongside this reference: the
data-source and transit how-tos, and the end-to-end walkthrough of writing an
integration, are separate developer pages.

## Map overlays

An integration that draws on the map (`domains` includes `map-overlay`, with a
`layerSelector` entry so users can toggle it) renders one of two ways.

### Declarative overlays (no shipped code)

When `frontend.overlay.source` is present, the overlay is **fully described in the
manifest** and a generic host renderer draws it — the integration ships no
frontend code. This is the preferred path: it is the most secure (no third-party
JavaScript runs in the app), works for community integrations without a frontend
bundle, and the host gets the lifecycle right once for everyone. The manifest
declares:

- a **`source`** — `geojson-bbox` (the host fetches the integration's own
  `route` and refetches it, debounced, as the user pans/zooms, substituting the
  viewport per `bboxParam`), `geojson` (fetched once), or `vector` (`tiles`);
- one or more **`layers`** — MapLibre Style-Spec layer objects (`type`, `paint`,
  `layout`, `filter`); mark a layer `interactive` to get a click popup;
- an optional **`legend`** (categorical swatches or a value→color ramp) and
  **`popup`** (a title field plus rows), both rendered by the host with every
  value escaped.

The host owns add/remove, re-anchoring beneath labels on base-map switch, the
bbox refetch, popups, interactive-layer registration, attribution (from the
manifest `dataSources`), and teardown. OpenConditions' road-conditions overlay is
the canonical example: a `geojson-bbox` source pointing at its `/observations`
route, a severity-colored circle layer, a categorical legend, and a popup —
all manifest, no bundle. See
[Building an external extension](./building-an-external-extension.md) for the
complete OpenConditions walkthrough (provider integration + companion ingest
service).

### Code overlays (shipped components)

When an overlay needs imperative logic (custom WebGL layers, animation, bespoke
interaction) it ships `map-layer.tsx` (and optionally `legend.tsx` / `panel.tsx`)
and sets the matching `frontend.mapLayer` / `legend` / `panel` flag. Built-in
overlays import the app's internals directly. **Community** code overlays reach
the map through the curated runtime surface exported from
`@openmapx/integration-framework/react`:

```tsx
import { useHostMap } from "@openmapx/integration-framework/react";
import maplibregl from "maplibre-gl";

export default function MapLayer() {
  const { mapRef, mapReady, styleVersion, getFirstSymbolLayerId, setLayerInteractive } = useHostMap();
  // add sources/layers to mapRef.current, anchor beneath labels, react to styleVersion…
  return null;
}
```

`useHostMap()` returns the live host map (`mapRef`, `mapReady`, `styleVersion`)
plus helpers (`getFirstSymbolLayerId`, `anchorBelowLabels`, `setLayerInteractive`).

### The community frontend runtime

Community integration frontends are built into a bundle and served back to the
web app at `/api/integrations/:id/bundle/*` (refused for built-ins). The web app
loads each as an ES module that self-registers its components onto
`window.__openmapx_integrations`. Crucially, the bundle does **not** ship its own
copy of React or the platform packages: it marks `react`, `react/jsx-runtime`,
`@openmapx/core`, `@openmapx/integration-framework` (+ `/react`), and
`maplibre-gl` as externals, and the page's import map resolves those to the
host's live singletons. So a community overlay shares the host's React, registry
context, and maplibre instance — hooks and context work across the boundary, and
its `maplibregl.Popup` operates on the host map.

:::note[CSP and the API origin]
The bundle `<script>` loads from the API origin. When the app and API share an
origin (the typical deployment, with `/api` proxied) the default
`script-src 'self'` covers it. A cross-origin API deployment must add the API
origin to the web app's `script-src`, or the browser blocks the bundle.
:::

## Lifecycle: discovery, loading, and hosting

The runtime owner of integrations is the **integration host** inside the API
server (`apps/api/src/integration-host.ts`). It runs the full lifecycle at boot,
and a reduced version on reload.

### 1. Discovery

The host scans each configured integration directory (`integrations/` for
built-ins, `custom_integrations/` for community installs), reads every
`manifest.json`, and skips directories that begin with `_` or have no manifest.
Discovery is metadata-only — no code runs yet — which is why an integration that
later crashes during setup is still known to the host by id.

### 2. Validation and ordering

Each manifest is validated. The required invariants are minimal — an `id`, at
least one `domain`, and a `healthCheck` whenever the integration declares a
required (non-optional) service dependency. Invalid manifests are skipped with a
warning rather than aborting the boot. Surviving integrations are then
**topologically sorted** by `dependencies` so each loads after the integrations
it depends on; a dependency cycle, or a dependency that is not installed, drops
the affected integration with a warning.

Before any integration loads, the host also performs a fail-fast check: if any
discovered manifest declares secret config fields but `OPENMAPX_SECRETS_KEY` is
unset, boot aborts with a clear remediation message rather than failing later on
a user request.

### 3. Per-integration setup

For each integration in dependency order the host:

1. resolves config through the cascade and emits advisory warnings for missing
   required keys or out-of-enum values (never blocking);
2. builds the per-integration clients (logger, HTTP, cache, and a `db` handle
   only when the manifest requires `postgis`);
3. resolves the `requires` entries against the service registry and capability
   bindings (see below);
4. assembles the `IntegrationContext` and, if the integration has a backend entry
   point, imports it and awaits `setup(ctx)`.

A disabled integration (its `enabled` config resolves to `false`) is recorded but
never set up. If `setup(ctx)` throws, the host marks the integration disabled,
emits an error event, and continues — one broken integration does not take down
the rest.

### 4. Serving

The host then exposes the integration surface to the rest of the API:

- `GET /api/integrations` lists the enabled integrations and their metadata,
  alongside the framework's shared localized strings.
- Integration-defined routes are served through a single mini-router
  (`/api/integrations/:id/*`). Fastify cannot register routes at runtime, so the
  host catches the wildcard and dispatches to the matching `registerRoute`
  handler — which is what makes reload possible.
- Health checks are seeded a few seconds after boot and refreshed on an interval.

### Reload versus restart

In development, `POST /api/integrations/reload` re-runs discovery and setup:
it invokes every `onShutdown` handler, clears the registry, and rebuilds it from
the freshly read manifests. Reload re-registers providers and lifecycle hooks and
re-reads config and bindings — which is why a config or binding change can take
effect without a full restart. The one thing reload cannot do is *remove* a
previously registered Fastify route or pick up *new backend code* in production
(ESM module imports are cached for the process lifetime). Adding or changing
backend code in a production deployment therefore requires restarting the API
container.

## Capability requirement resolution

Each `requires` entry is resolved once at load time and exposed to the
integration through `ctx.getRequiredService(key)`. The resolution rules:

- **`{ service: "<id>" }`** is satisfied when that specific service is installed
  and enabled. The lookup key is the service id.
- **`{ capability: "<cap>" }`** with exactly one installed provider auto-selects
  it. With multiple providers it is *ambiguous* and stays unresolved until an
  administrator picks a binding; the host logs a warning meanwhile. The lookup
  key is the capability name.
- **`{ optional: true }`** that goes unresolved falls through silently — the
  integration is expected to fall back to a public default (for example a public
  routing endpoint).

Inside `setup`, an integration reads the resolved target and applies its own
fallback:

```ts
export function setup(ctx: IntegrationContext) {
  const engine = ctx.getRequiredService("routing-engine");
  const baseUrl = engine?.url ?? (ctx.config.baseUrl as string) ?? PUBLIC_FALLBACK;
  // … register a provider that calls baseUrl
}
```

A resolved entry returns `{ serviceId, url, enabled }`, where `url` is the
service's address on the private Docker network. Whether a `capability`
requirement with several candidates resolves at all depends on the
administrator's **binding** — the stored `(integration, capability) → service`
mapping chosen in the admin panel. The host loads all bindings once at startup
and re-reads them on reload. The full binding workflow is documented on the
[Integrations & bindings](../administration/integrations-administration.md#capability-bindings)
page.

## Built-in versus community

The host treats the two install locations differently, and the
`isBuiltIn` flag on a loaded integration drives the distinction:

- **Built-in integrations** ship in the repository under `integrations/`. They
  run directly from workspace TypeScript source — the host imports their
  `index.ts` — and need no build step. They carry `quality: "built-in"`.
- **Community integrations** are installed under `custom_integrations/` and run
  from a prebuilt ESM bundle; the API never compiles code at runtime. Their
  frontend bundles are served back to the web app through a dedicated route
  (`/api/integrations/:id/bundle/*`), which is refused for built-ins. A community
  integration may declare a minimum `platform` version in its manifest; if the
  running platform's major version differs, or its minor is lower, the host skips
  the integration with a warning. The platform version uses simple
  `major.minor` semantics — the major is bumped for breaking changes to the
  manifest schema, context, or contracts, the minor for additive ones.

Installing and managing community integrations is an administrator task; see
[Community extensions](../administration/community-extensions.md).
