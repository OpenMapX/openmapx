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
under `custom_integrations/` and are limited to declarative metadata and
frontend assets (see
[Built-in versus community](#built-in-versus-community)). The host only requires
two things to be present:

- **`manifest.json`** — declarative metadata. Required. This is what the host
  discovers and validates; an integration with only a manifest and no code is a
  valid (if inert) integration.
- **`index.ts`** — the trusted built-in runtime entry point. Optional and not
  permitted in an installable community artifact.
  It exports a `setup(ctx)` function that the host invokes once at load time,
  passing the [`IntegrationContext`](#the-integration-context). This is where an
  integration registers providers, routes, and lifecycle hooks.

Most integrations also ship `strings/<locale>.json` localization files and, when
they have a frontend, a map overlay — the MapLibre layer component, plus
optional legend and panel components. An overlay's legend can be declared in the
manifest instead of shipped as code. See [Map overlays](#map-overlays).

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
(`/api/integrations/<id>/...`). It is constrained to a safe slug because it also
names files, URLs, and generated build-time identifiers.

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
`street-level-imagery`, which have no backend registrar) are expressed the same way. The
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
    layerSelector?: {
      group: "map-details" | "map-tools" | "map-types";
      labelKey: string;
      icon?: string;
      preview?: string | null; // integration-root-relative SVG, e.g. "preview.svg"
    };
    overlay?: {
      excludes?: string[];   // overlay ids this one is mutually exclusive with
      minZoom?: number;
      // Declarative legend — the host renders it, so no legend.tsx is needed
      // (see "Map overlays" below):
      legend?: {
        kind: "categorical" | "ramp";
        title?: string; titleKey?: string;
        items?: Array<{ color: string; label?: string; labelKey?: string }>;  // categorical
        stops?: Array<{ value: number; color: string }>;                      // ramp
      };
    };
  };
  backend?: {
    routes?: boolean;        // registers routes via ctx.registerRoute
    cron?: string | null;    // cron expression for a periodic task
  };
}
```

`mapLayer` / `legend` / `panel` advertise **trusted built-in code** components.
Installable community manifests that set those flags are rejected until a
cross-origin sandbox and capability protocol exist. `searchCategory` and `layerSelector` are pure
declarations the host renders (a search-bar category chip; a layer-selector
entry). `overlay` carries mutual-exclusion rules (`excludes`), `minZoom`, and an
optional **declarative legend** the host draws from the manifest, which an
overlay can use instead of shipping a `legend.tsx`. `backend.routes` signals that
the integration registers HTTP routes; `backend.cron` declares a recurring task.
How an overlay renders is detailed in [Map overlays](#map-overlays).

When `layerSelector.preview` is set, it names an SVG file relative to the
integration root, such as `preview.svg` or `assets/layer-preview.svg`. The host
serves the file and renders it as an external decorative image; it does not
execute preview code or insert the SVG markup into the page. Preview assets must
be SVG files no larger than 64 KiB. Remote URLs, data URLs, inline SVG values,
absolute paths, and paths that escape the integration directory are not
accepted. If `preview` is omitted or `null`, or if the image cannot be loaded at
runtime, the layer selector uses its generic placeholder.

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
    owner?: string;
    termsUrl?: string;
    methodologyUrl?: string;
    dataUseClass?: "open" | "attribution" | "share-alike" | "non-commercial" | "restricted" | "unknown";
    credentialOwner?: "none" | "instance-operator" | "openmapx-project" | "end-user";
    reviewedAt?: string;              // ISO date, YYYY-MM-DD
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
  readonly upstreamRuntime?: UpstreamRuntime;           // distributed cache/lease/quota
  readonly cursorCodec?: OpaqueCursorCodec;             // signed, purpose-scoped cursors
  // …
}
```

These let an orchestrator skip a provider that is in a failure cooldown, record
per-call latency and outcome, and resolve attribution rows — without the
framework taking a compile-time dependency on the API server (they are declared
as structural interfaces and injected by the host).

`upstreamRuntime` is the production primitive for quota-bound acquisition. Its
cache returns `fresh`, `stale`, `stale-if-error`, or `miss`; a refresh lease is
owner-released; and all named quota windows are checked and consumed atomically.
Do not replace it with process-local maps or counters in production. Redis
failure must deny a new quota-consuming refresh, although eligible stale data
may still be returned with its original evidence time.

Use `http.getResponse()` when status or allowlisted rate-limit headers matter,
and `http.getBytes()` for binary payloads. Both require a byte ceiling and media
type allowlist; redirects can be rejected. Non-success bodies are bounded too.
Integration-local raw `fetch` is not an escape hatch for provider work.

Route queries arrive exactly as Fastify parsed them: each value is a string, an
array for a repeated key, or undefined. Use `scalarQuery`/`scalarQueries` and
reject repeated scalar keys. Never coerce an array with `String(...)` or select
one value silently.

Opaque cursors are HMAC-signed and purpose-scoped. Bind their encoded value to
the normalized query/provider context and give it a finite expiry; decoding a
cursor under another route purpose must fail.

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
  registerRoadConditionsProvider(p: RoadConditionsProvider): void; // → "road-conditions"

  registerPoiSources(sources: readonly PoiSource[]): void;    // → data-manager ingest
  registerRoute(method, path, handler, options?): void;       // options.rateLimitTier
  registerHealthCheck(fn: CustomHealthCheckFn): void;         // overrides manifest probe
  registerDisclosure(d: Disclosure): void;                    // surfaces a capability note
}
```

The typed registrars enforce the contract shape at compile time, so the
orchestrator can dispatch on a declared capability rather than reflecting over
the object. `registerPoiSources` is different in kind: it forwards entries to the
shared POI-source registry that the data-manager ingest pipeline also reads, so
large bbox-queryable datasets are ingested once rather than fetched eagerly per
request. `registerRoute` mounts a route under the integration's prefix; passing
`{ requireAuth: true }` makes the host reject unauthenticated callers with 401
before the handler runs. Every route consumes exactly one host limiter bucket:
`rateLimitTier` defaults to `public`, upstream-heavy point/list routes use
`expensive`, and tile fan-out uses `tile`. Do not add integration paths to the
global URL-pattern limiter.

Provider health accepts only closed outcomes. Timeouts, connection failures,
upstream 5xx responses, authentication failures, and invalid payloads affect the
circuit; valid empty results, policy/input rejection, quota denial, and caller
cancellation remain observable without penalizing the provider. Keep bounded
operator detail separate from the outcome code. Air-quality metrics likewise
accept only closed method, outcome, cache, evidence-class, rejection, quota, and
compatibility fields; user strings and location identifiers are not labels.

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
| `road-conditions` | `RoadConditionsProvider` | Live road/traffic conditions — incidents, roadworks, closures, and per-segment congestion speeds. |

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
`map-overlay` or `street-level-imagery` — still appear in `domains`, but they contribute
UI surfaces and routes rather than a registered provider object.

The per-contract authoring guides live alongside this reference: the
data-source and transit how-tos, and the end-to-end walkthrough of writing an
integration, are separate developer pages.

## Map overlays

 A trusted built-in integration that draws on the map (`domains` includes
`map-overlay`, with a `layerSelector` entry so users can toggle it) ships a
`map-layer.tsx`. Its
legend is the one part it can declare instead of writing.

### Declarative legends (no shipped legend code)

`frontend.overlay.legend` describes the legend in the manifest and a generic host
renderer draws it, so an overlay needs no `legend.tsx`. Declare a `kind` of
`categorical` (discrete `items`, each a color plus a `label` or `labelKey`) or
`ramp` (a value→color gradient given as `stops`), with an optional `title` or
`titleKey`. The host escapes every value it renders.

`frontend.overlay` also carries `excludes` (sibling overlays that switch off when
this one switches on) and `minZoom`.

### Map layers (shipped components)

For trusted built-ins the layer itself is a shipped component: `map-layer.tsx`, with the
`frontend.mapLayer` flag set (and `frontend.legend` plus a `legend.tsx` when the
declarative legend above isn't expressive enough). Built-in overlays import the
app's map context and layer utilities directly:

```tsx
import { useMap } from "@/lib/MapContext";

export default function MapLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  // add sources/layers, anchor with the host utilities, react to styleVersion…
  return null;
}
```

### Crediting an overlay's sources

The map layer registers its credits, and they appear in the map credits strip
along the bottom of the map for as long as the layer is drawn. Legends never
carry credits — they explain colors and symbols only, and can be collapsed away.

Credit an overlay's own `dataSources` with `useIntegrationAttribution(id,
visible)`. When the overlay paints data published by *sibling* integrations
(a domain orchestrator such as live transit or road conditions), its own
`dataSources` list is empty, so credit the whole domain instead with
`useIntegrationDomainAttribution(domain, visible)` — crediting an empty list
registers nothing. Credits that arrive with a response rather than a manifest
(`MobilityResult.attributions`) go through `useMapAttributions(key, attributions)`.
Either way the wording comes from the manifest, never from hand-rolled strings.

### Community presentation boundary

Community integration artifacts are declarative-only. The installer rejects
`map-layer.tsx`, `legend.tsx`, `panel.tsx`, and prebuilt frontend bundles; app-api
does not serve a bundle route; and the web provider never appends community
scripts. This is deliberate: a same-origin script has the signed-in user's full
authority, and CSP cannot sandbox code the application intentionally executes.
Executable community presentation will remain disabled until it can run on a
separate origin (or equivalently isolated worker) behind a narrow, versioned
message/capability API. Static SVG previews and host-rendered manifest fields
remain supported.

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

In development, `POST /api/integrations/reload` re-runs discovery and setup.
The host builds a detached generation, then atomically swaps its registry,
dynamic routes, POI registrations, and event subscriptions before retiring the
old generation. A failed setup leaves the serving generation untouched. Config
and binding changes therefore take effect without exposing a partially rebuilt
host. Trusted built-in backend imports are cache-busted when their entry file
changes.

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
- **Community integrations** are installed under `custom_integrations/`. Their
  manifests and safe static assets are discovered, but backend, `poi-sources`, and frontend
  JavaScript is never imported by app-api or data-manager: those processes hold
  database credentials, application secrets, a writable checkout, and Docker
  authority and are not sandboxes. The installer rejects such entry points.
  Backend behavior belongs in a separately containerized service component;
  executable presentation remains disabled until a cross-origin sandbox exists. A community
  integration may declare a minimum `platform` version in its manifest; if the
  running platform's major version differs, or its minor is lower, the host skips
  the integration with a warning. The platform version uses simple
  `major.minor` semantics — the major is bumped for breaking changes to the
  manifest schema, context, or contracts, the minor for additive ones.

Installing and managing community integrations is an administrator task; see
[Community extensions](../administration/community-extensions.md).
