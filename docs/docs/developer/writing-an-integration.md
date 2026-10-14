---
title: Writing an integration
description: A hands-on walkthrough for trusted built-in integrations — scaffold a directory, write the manifest, and implement setup(ctx) in the OpenMapX monorepo.
sidebar_position: 5
---

# Writing an integration

:::note
Building an integration in your **own repository**? See [Building an external extension](./building-an-external-extension.md) for the separate declarative-artifact and companion-service path.
:::

This page builds a trusted **built-in** integration from an empty directory to
a working in-tree feature. It assumes you have read the
[Integration system](./integration-system.md) concepts — the manifest, the
`IntegrationContext`, domains, and the loader-to-host lifecycle — and have a
working [development setup](./development-setup.md) with the API running under
hot reload. Here we put those concepts to work end to end.

The example throughout is a small **knowledge** provider that exposes one HTTP
route fetching sunrise and sunset times for a coordinate. It is deliberately
minimal: a manifest, one `setup(ctx)` function, a cache read-through, and
attribution metadata. The same trusted built-in pattern scales up to a weather
provider, a POI data source, or a transit provider — the only thing that
changes is which registrar you call.

For the two data-rich domains with their own typed contracts and orchestration
rules, follow the dedicated guides once you have the basics here:

- [Data-source integrations](./data-source-integrations.md) — bike/car/scooter
  sharing, and the merged charging, parking, fuel, and webcam categories.
- [Transit integrations](./transit-integrations.md) — stops, departures, trip
  planning, vehicle positions, and alerts.

## Quick start: scaffold

The fastest way to start a new built-in integration is the scaffold generator.
It copies `integrations/_template/` into a new `integrations/<id>/` directory
and substitutes the `__ID__` and `__DOMAIN__` tokens throughout all files:

```bash
pnpm openmapx integrations scaffold my-feature --domain knowledge
```

This creates:

```
integrations/my-feature/
  manifest.json      pre-filled with id and domain tokens replaced
  index.ts           example setup(ctx) with a GET /ping route and cache usage
  package.json       workspace member (renamed from package.json.template)
  strings/
    en.json          localized name + description stubs
```

After scaffolding, run `pnpm install` once so pnpm picks up the new workspace
package, then continue with [Write the manifest](#write-the-manifest) to fill
in your real data sources, health check URL, and author info.

## Scaffold the directory

An integration is just a directory. Create this trusted built-in integration
under `integrations/` so the API loads it directly from TypeScript source — no
build step, and `pnpm dev`'s `node --watch` picks up your edits. Community
extensions use a separate declarative artifact and companion-service contract;
do not convert this directory into one.

```bash
mkdir -p integrations/knowledge-sunrise-sunset/strings
cd integrations/knowledge-sunrise-sunset
```

A built-in integration in the monorepo also gets a tiny `package.json` so pnpm
treats it as a workspace member and resolves the framework packages.

```json
{
  "name": "@openmapx/integration-knowledge-sunrise-sunset",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@openmapx/core": "workspace:^",
    "@openmapx/integration-framework": "workspace:^"
  }
}
```

The directory name should match the manifest `id`. The end state is small:

```
integrations/knowledge-sunrise-sunset/
  manifest.json      declarative metadata (required)
  index.ts           setup(ctx) entry point
  package.json       workspace member (built-in development only)
  strings/
    en.json          localized name + description
    de.json          optional translation
```

## Write the manifest

`manifest.json` is the declaration the host discovers and validates. It is the
single source of truth for the integration's identity, the domains it serves,
the backends it needs, its config form, and — critically — its attribution and
privacy metadata. The full schema is documented in the
[Integration system](./integration-system.md#the-manifest); here is a complete,
minimal one for our route-only knowledge provider:

```json
{
  "id": "knowledge-sunrise-sunset",
  "version": "1.0.0",
  "author": "You",
  "license": "MIT",
  "domains": ["knowledge"],
  "frontend": { "mapLayer": false, "legend": false, "panel": false },
  "backend": { "routes": true },
  "quality": "built-in",
  "category": "Knowledge",
  "healthCheck": {
    "type": "http",
    "url": "https://api.sunrise-sunset.org/json?lat=0&lng=0&formatted=0"
  },
  "dataSources": [
    {
      "sourceId": "sunrise-sunset",
      "name": "Sunrise-Sunset.org",
      "url": "https://sunrise-sunset.org/",
      "licensing": {
        "version": 1,
        "bindings": [
          {
            "scope": "service",
            "subject": "Sunrise-Sunset.org API",
            "license": { "kind": "unknown", "url": "https://sunrise-sunset.org/terms" }
          }
        ]
      },
      "commercialUse": "unknown",
      "providerCountry": "Unknown",
      "providerPrivacyUrl": "https://sunrise-sunset.org/privacy",
      "endUserExposure": "server-only",
      "personalData": false,
      "cookies": false,
      "dpaAvailable": false
    }
  ]
}
```

A few things worth pausing on:

- **`id`** is load-bearing. It names the directory, the config namespace, the
  environment-variable prefix, and the route prefix (`/api/integrations/<id>/…`).
  It must match `/^[a-z0-9][a-z0-9-]*$/`.
- **`domains`** is the join key to an orchestrator. A `knowledge` integration is
  picked up by the knowledge orchestrator; a `weather` one by the weather
  orchestrator. You can declare more than one.
- **`backend.routes: true`** advertises that `setup(ctx)` mounts HTTP routes.
  Set `frontend.*` flags for the UI surfaces you contribute instead.
- **`dataSources`** is not optional bookkeeping. The legal pages and the
  receipt metadata derive from these entries, and a host-side completeness gate
  fails the commit if a generated table cell would be empty. Results capture only
  their actual suppliers, including runtime-feed/per-file notices.
  Any integration with `backend.routes: true` is required to declare a
  `dataSources` entry per upstream API it calls. Keep `sourceId` stable and
  globally unique — renaming it orphans existing attribution.

### Declaring a backend dependency

Our example talks to a public HTTP API and needs no self-hosted service. When an
integration _does_ need one — a routing engine, an Overpass server, PostGIS —
declare it under `requires`. Each entry names exactly one of `service` (a
specific service slug) or `capability` (any provider of that capability), and may
be `optional`:

```json
{
  "requires": [{ "service": "valhalla", "optional": true }]
}
```

At load time the host resolves each entry and exposes it through
`ctx.getRequiredService(key)`, where the key is the service slug or the
capability name. An `optional` requirement that goes unresolved falls through
silently so the integration can fall back to a public default. The backing
services themselves are declared with their own
[service manifest](./service-manifest.md); resolution and capability bindings are
covered in the [Integration system](./integration-system.md#capability-requirement-resolution).

### Declaring a config schema

If your integration needs settings — an API key, an endpoint override, an
enabled flag — describe them with `configSchema`. The admin panel renders it as a
form, and the host uses it to know which keys exist and their defaults. Our
example needs none, but a provider with a key looks like this:

```json
{
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "apiKey": {
        "type": "string",
        "title": "Provider API key",
        "x-openmapx-secret": true
      }
    }
  }
}
```

A property marked `"x-openmapx-secret": true` is a credential: it is hidden from
the config form and API responses, set through the Credentials tab, and stored in
the encrypted vault. Note that declaring _any_ secret field makes the integration
refuse to load unless `OPENMAPX_SECRETS_KEY` is set — a missing key is a hard boot
error, not a silent degrade. The layered resolution of these values — defaults,
database, vault, `config.json`, and environment — is the config cascade, and the
environment override for a key follows the pattern
`INTEGRATION_<ID>_<KEY>` (id and key upper-cased, hyphens and camelCase to
underscores), for example `INTEGRATION_KNOWLEDGE_SUNRISE_SUNSET_API_KEY`.

### Helping operators obtain a key (`x-openmapx-setup`)

A credential field is only useful if the operator can actually get a value for
it. Attach an `x-openmapx-setup` block to any credential property — a vault
secret or a plain `"format": "password"` key field — and the admin panel renders
a "Get API key" button, an optional pre-written request email, a free-tier hint,
and a collapsible step-by-step guide right next to the input (on the Credentials
tab, the bulk-configure page, the config form, and the Set-credential dialog):

```json
{
  "apiKey": {
    "type": "string",
    "title": "Provider API key",
    "x-openmapx-secret": true,
    "x-openmapx-setup": {
      "url": "https://provider.example/account/keys",
      "urlLabel": "Open dashboard",
      "steps": [
        "Create a free account at provider.example.",
        "Open Account → API keys.",
        "Create a key and copy it."
      ],
      "cost": "Free tier: 100k requests/month",
      "notes": "Activation can take a few minutes.",
      "email": {
        "to": "api@provider.example",
        "subject": "API access request",
        "body": "Hello,\n\nI'd like to request an API key for ..."
      }
    }
  }
}
```

Every field is optional. Use `email` only for providers that grant access by
manual request (it renders a `mailto:` with the subject/body pre-filled); for
self-service providers a `url` plus `steps` is enough. Keep the steps short and
imperative — they are operator instructions, not prose.

### Adding a map overlay

This walkthrough builds a trusted built-in route-only provider, so its `frontend`
flags are all `false`. A built-in map integration can ship a `map-layer.tsx`
(and optionally `legend.tsx` / `panel.tsx`), set the matching
`frontend.mapLayer` / `legend` / `panel` flag, add `domains: ["map-overlay"]`
and a `layerSelector` entry so users can toggle it. A simple
legend can be declared as `frontend.overlay.legend` in the manifest rather than
written, and the layer registers the credits that appear in the map credits
strip while it is drawn.

Compiled built-ins import web capabilities through focused
`@/integration-api/map/...`, `overlay/...`, `runtime/...`, or `components/...`
paths. This is the trusted web host's app-local API, not an extension SDK.
Installed community integrations cannot execute presentation JavaScript and
cannot consume these modules; they remain declarative-only.

The full `frontend.overlay` schema and the community-code restriction are documented in
[Integration system → Map overlays](./integration-system.md#map-overlays).

## Implement `setup(ctx)`

`index.ts` exports a `setup(ctx)` function that the host calls once at load time,
passing the [`IntegrationContext`](./integration-system.md#the-integration-context).
This is the integration's entire interface to the platform — you never import the
API server, the database driver, or Redis directly. You register what you provide
and return.

For our route-only example, `setup` registers a single GET route under the
integration's prefix and uses the namespaced cache for a read-through:

```ts
import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withContributors,
} from "@openmapx/integration-framework";

const API_BASE = "https://api.sunrise-sunset.org/json";
const CACHE_TTL = 21_600; // 6 hours — sun times change slowly

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/times", async (req, reply) => {
    const { lat, lng } = req.query as { lat?: string; lng?: string };
    const latNum = Number.parseFloat(lat ?? "");
    const lngNum = Number.parseFloat(lng ?? "");

    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      reply.status(400).send({ message: "Invalid coordinates" });
      return;
    }

    const cacheKey = `sun-times:${latNum},${lngNum}`;
    const result = await ctx.cache.withCache(cacheKey, CACHE_TTL, async () => {
      // Capture the known supplier before acquiring this cache generation.
      const captured = resolveIntegrationContributors(ctx, ["sunrise-sunset"]);
      const url = `${API_BASE}?lat=${latNum}&lng=${lngNum}&formatted=0`;
      const body = await ctx.http.get<{
        status: string;
        results: { sunrise: string; sunset: string };
      }>(url);
      if (body.status !== "OK") {
        ctx.log.warn(`Sunrise-Sunset API status: ${body.status}`);
        throw new Error("Sunrise-Sunset data unavailable");
      }
      return withContributors(body.results, captured);
    });

    reply.send(result);
  });
}
```

The route is now served at `GET /api/integrations/knowledge-sunrise-sunset/times`
— the host prefixes every registered route with the integration's id. A few
context conveniences are doing the work here:

- **`ctx.registerRoute(method, path, handler, options?)`** mounts the route under
  the integration prefix. Pass `{ requireAuth: true }` to make the host reject
  unauthenticated callers with 401 before your handler runs; the authenticated
  user id is then available as `req.userId`. The incoming request's headers are
  forwarded as `req.headers` (`Record<string, string | string[] | undefined>`);
  Node lowercases every header name when parsing the request, so read
  `req.headers["if-none-match"]`, not `req.headers["If-None-Match"]`.
- **`ctx.cache`** is a key-value store namespaced per integration
  (`int:<id>:<key>`), so you cannot collide with another integration's keys. Its
  `withCache(key, ttl, fn)` helper reads through on a miss and stores the result.
- **`ctx.http`** is a small `fetch` wrapper that can transparently cache GET
  responses in Redis when you pass a `{ cache: { ttl } }` option.
- **`ctx.log`** is a structured logger already tagged with the integration id.

`ctx` also exposes `secrets`, an optional `db` (present only when the manifest
requires `postgis`), and an event bus —
the full surface is enumerated in the
[Integration system](./integration-system.md#services-available-to-integration-code).

### Registering a provider instead of a route

Routes are right for a small enrichment endpoint. For the data-rich domains, you
register a **provider** that implements that domain's typed contract, and the
domain orchestrator merges it with the other installed providers. The context has
one typed registrar per contract; a weather provider, for example, is a plain
object implementing the `WeatherProvider` interface:

```ts
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { WeatherProvider } from "@openmapx/integration-weather/types";

const openMeteoProvider: WeatherProvider = {
  id: "open-meteo",
  priority: 10,
  async getCurrentWeather(coords, options) {
    /* fetch + map to the canonical WeatherResponse */
  },
};

export function setup(ctx: IntegrationContext): void {
  ctx.registerWeatherProvider(openMeteoProvider);
}
```

The same shape holds for `registerGeocodingProvider`, `registerRoutingProvider`,
`registerKnowledgeProvider`, `registerPhotoProvider`, and the rest. The typed
registrars enforce the contract at compile time, so the orchestrator dispatches
on a declared capability rather than reflecting over your object. Providers in a
domain capture exact source receipts from the declared metadata at acquisition,
then retain them on the records they return. The framework's contributor helpers
convert, copy and project canonical receipts; a whole manifest/domain is not
proof that every listed supplier contributed. Runtime feed and per-file notices
must survive alongside static source metadata. The two mobility contracts have extra rules (capability
self-description, coverage, priority) covered on their own pages.

### Keep receipts with the data

The route example captures `sunrise-sunset` before its HTTP await and caches the
receipt with the result. Capture inside the cache-miss callback: a cache hit must
keep its earlier acquisition metadata. Use `ctx.http` for requests and
`ctx.upstreamRuntime` for quota-bound work, preserving source-policy controls.
If the response chooses an unknown backend/feed, capture its lookup catalogue
before awaiting rather than looking up current registry metadata afterward:

```ts
import {
  captureIntegrationContributorCatalogue,
  resolveCapturedContributors,
  withContributors,
} from "@openmapx/integration-framework";

// Inside an acquisition, with ctx and acquire() supplied by this provider:
const catalogue = captureIntegrationContributorCatalogue(ctx, "transit");
const rows = await acquire();
const capturedRows = rows.map((row) =>
  withContributors(row, resolveCapturedContributors(catalogue, providerId, row)),
);
```

Here `row` must supply canonical `contributors` or exact `sourceIds`. Missing
mixed provenance remains unknown; the catalogue must never be displayed as a
union. Supplied `contributors: []` cannot fall back to `sourceIds`, provider
labels, manifests or a domain. The [captured contract](./integration-system.md#captured-contributor-contract)
also covers field ownership and compatibility boundaries.

For mixed enrichment, project the fields the view actually displays:

```ts
import {
  captureFieldContributors,
  contributorsForRecordFields,
} from "@openmapx/integration-framework";

// Keep the complete winning container tree, including explicit empty children.
const winningBrandOwnership = captureFieldContributors(winner, "brand");
// Website/hidden facts do not get credited just because the record has them.
const displayedCredits = contributorsForRecordFields(place, ["name", "address"]);
```

First-wins, gap-fill and replacement merges retain the ownership of the winning
field; append receipts only when a field/identity is actually kept. A discarded
duplicate gets no credit. Itemized facts/photos retain their own receipts, and
Commons photos additionally retain their exact author, license and file page.
Do not replace selected display lineage with the broader rights-dependency set.

### Register map and panel credits through the host

Trusted map components use
`@/integration-api/overlay/useRenderedMapAttributions` for captured GeoJSON/MVT
feature receipts, and `@/integration-api/overlay/useRasterMapAttributions` for
effective raster supplier descriptors. The [map contract](./integration-system.md#crediting-an-overlays-sources)
details paint channels, overzoom, field projection, DOM/custom GPU proof and
raster acquisition order. A minimal uniform-feature example is:

```tsx
import { withFeatureContributors } from "@openmapx/integration-framework";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";

// Stamp before source/bridge publication, using the acquisition snapshot.
const ownedFeature =
  feature.contributors === undefined
    ? feature
    : withFeatureContributors(feature, feature.contributors);
// In the React layer, subscribe to the layers that actually paint this data.
useRenderedMapAttributions("my-feature", [POINTS_LAYER, LABELS_LAYER], visible);
```

For a proven uniform layer, `layerContributors` can hold its captured receipt;
for a heterogeneous layer, attach each feature's own receipt or project its
captured fields. Authoritative `[]` suppresses fallback. Capture one descriptor
per raster supplier, call `addAttributedRasterSource` before adding its layer,
and update future acquisition receipts before changing tile URLs. Successful
retained content keeps its earlier receipt during refresh failures.

A proxy that can choose a different supplier for each tile must use
`addAttributedRasterSource(..., [], "response")` (or `RasterBaseLayer`'s
`receiptMode="response"`). It returns `X-OpenMapX-Contributors` on each successful
image response: `encodeURIComponent(JSON.stringify(canonicalContributors))`, at
most 16 KiB, including mandatory underlying-data/style notices. Capture and
serialize that receipt before awaiting its acquisition. Store the header with
the corresponding image in HTTP caches and expose it through CORS where needed.
Do not use a HEAD probe or the latest provider configuration to identify content.
Missing, malformed and explicit empty receipts all contribute no inferred supplier.

The trusted web host installs `attributedRasterRequestTransform(existingPolicy)`
on its Map constructor; wrap later `setTransformRequest` policies the same way.
Policies see the original canonical HTTP URL and keep their request headers,
credentials, cache mode and referrer policy. The host's per-load protocol token
never reaches the server or its cache key. The bridge accepts HTTP(S) response
producers, limits encoded images to 8 MiB, and commits each response snapshot
only when that same native load commits its texture. Browser HTTP revalidation
retains body/header identity; a standalone 304 without cached content is an error.
This is a trusted host transport contract, not executable community extension code.

Panels import `AttributionStrip` from
`@/integration-api/components/AttributionStrip` and pass the receipts projected
from the displayed fields/rows, including represented secondary items and
alerts. Independent map ownership remains necessary when its panel is closed.
Legends may credit data displayed by the legend itself, such as a fetched weather
reading; they do not own the map's credits.

Add behavioral tests for malformed/empty receipts, acquisition-time metadata,
field replacement/container children, retained caches, actual pruning and
rendered visibility. The static wiring test rejects toggle/domain-only hooks,
unused imports and test-only mentions, but cannot certify the provenance passed
to a correctly imported hook.

### Declaring temporal support

A routing provider that can be used for trips with per-stop times declares what
it can honor, one line per semantic:

```ts
export const valhallaService: RoutingProvider = {
  // …
  temporal: {
    tripDepartAt: "native",
    tripArriveBy: "native",
    dwell: "native",
    waypointDepartAfter: "emulated",
    waypointArriveBy: "emulated",
    timeDependentTravel: "native",
  },
};
```

The four levels mean exactly this:

- `native` — the engine itself enforces the semantic.
- `emulated` — OpenMapX enforces it exactly, by orchestrating several engine
  calls. The result is correct.
- `approximate` — enforced arithmetically, but on travel times that do not vary
  with the departure instant. The wall clocks are estimates, and the app says so.
- `unsupported` — cannot be honored. A request needing it is rejected with the
  reason rather than served with something else.

One rule is checked repo-wide: a provider whose `timeDependentTravel` is
`unsupported` must not claim `native` on anything else, because a schedule built
on time-invariant durations cannot be exact no matter how the arithmetic is done.
OSRM, for instance, declares every semantic `approximate`.

Declaring nothing is fine. A provider that omits the block is read through its
`supportsTimeAware` flag: time-aware providers get native trip anchors and
emulated per-waypoint semantics (leg chaining works against any `getRoute`),
everything else gets the approximate defaults. Transit providers declare the same
block under `capabilities.planningFeatures.temporal`, alongside a `chaining` flag
that says they can serve one segment of a multi-stop journey.

### Localized strings

Drop an English `strings/en.json` (and any translations) next to `index.ts`. The
host loads them by convention; the active locale comes from the request's
`Accept-Language`. The `name` and `description` power the admin list and
integration cards, and the `dataSources` block feeds the per-source rows on the
generated legal pages:

```json
{
  "name": "Sunrise-Sunset",
  "description": "Sunrise, sunset, and twilight times for any location",
  "dataSources": {
    "sunrise-sunset": {
      "purpose": "Sunrise and sunset times for place details",
      "dataSent": "Coordinates (latitude, longitude)",
      "dataReceived": "Sunrise, sunset, solar noon, twilight times"
    }
  }
}
```

The `dataSources` object is keyed by the `sourceId` from your manifest — not a
positional array — so the keys must line up with the manifest's source IDs.

## Develop it in-tree

With the integration sitting under `integrations/` and the API running under
`pnpm dev`, `node --watch` reloads on every edit. The host re-runs discovery and
setup, so your manifest and `setup(ctx)` changes take effect without a manual
restart. You can also trigger a reload explicitly in development:

```bash
curl -X POST http://localhost:3001/api/integrations/reload
```

Reload stages providers, dynamic routes, lifecycle resources, and bindings in a
detached generation, then swaps it into service before retiring the old one. A
failed setup leaves the current generation serving. Trusted built-in entry files
are cache-busted when their contents change. Confirm the integration is loaded
and hit its route:

```bash
curl http://localhost:3001/api/integrations | jq '.integrations[].id'
curl "http://localhost:3001/api/integrations/knowledge-sunrise-sunset/times?lat=51.5&lng=-0.1"
```

You can validate the manifest at any point without restarting the server:

```bash
pnpm openmapx integrations validate knowledge-sunrise-sunset
```

## Community extensions use a separate contract

An integration under `integrations/` is **built-in**: it runs from workspace
TypeScript source, needs no build step, and ships in this repository. This
walkthrough intentionally ends at that trusted boundary.

A community artifact is not a packaged form of this directory. It contains only
declarative metadata and safe static assets; backend code, providers, POI
sources, presentation modules, and runtime bundles are rejected. Put executable
behavior in a companion service, then package the declarative artifact and pin
both in an `extension.json`. Follow [Building an external
extension](./building-an-external-extension.md) for that separate workflow and
the [Community extensions](../administration/community-extensions.md) guide for
operator installation.

## Framing the map

Move the camera through the map context, never on the MapLibre instance
directly:

```ts
const { flyTo, fitBounds } = useMap();
flyTo([lng, lat], 15);
fitBounds(
  [
    [west, south],
    [east, north],
  ],
  60,
  { maxZoom: 16 },
);
```

`fitBounds`' padding is breathing room _inside_ the visible area. The app
subtracts the side panel, the mobile sheet, and the navigation chrome itself, so
an integration never needs to know how wide the panel is. It also leaves the
map's rotation alone — a user who aligned the map to the street grid keeps that
alignment — so pass `{ bearing: 0 }` only for a view that has to be read
north-up. A structural test (`apps/web/src/lib/cameraFramingGate.test.ts`)
rejects raw `map.fitBounds`, `map.flyTo`, and `map.jumpTo` calls outside the few
files that own a standalone map.

## Where to go next

- **[Data-source integrations](./data-source-integrations.md)** — the typed
  contract and orchestration for map data sources: sharing, and the merged
  charging, parking, fuel, and webcam categories.
- **[Transit integrations](./transit-integrations.md)** — stops, departures,
  trip planning, and realtime overlays.
- **[Integration system](./integration-system.md)** — the manifest schema, the
  context, and the loader-to-host lifecycle in depth.
- **[Service manifest](./service-manifest.md)** — declaring a backing service
  your integration requires.

### Composed route geometry receipts

A composed road route carries `geometryContributors`, an ordered array of
`{ startIndex, endIndex, contributors }` spans into its `geometry`. Both indices
are inclusive; adjacent spans share their endpoint. Each span captures the full
receipt at acquisition, including distinct required notices. `[]` means unknown
or explicitly unattributed geometry and is authoritative. Gaps also remain
unknown. A route without spans can use its captured `geometry` field receipt;
renderers never reconstruct historical geometry receipts from the current
catalogue.

Keep these boundaries when joining provider results, caching, serializing or
restoring navigation. Joining unequal endpoints introduces an unknown connecting
edge. Aggregate distance/duration credits remain separate from geometry, and
first-route-only values such as the summary retain only their actual owner.

The web host paints these spans as independently queryable features in planning,
alternative, proposed and navigation routes. Navigation gives each span a filtered
traveled/remaining/casing layer group and converts global Mercator progress into
that span's local gradient interval. GPS updates change paint only; they never
upload the route again. Only these complementary groups certify full alpha
coverage; a standalone partial gradient is not proof of visible geometry.

Use the [shared licence metadata contract](./licensing.md) for every declared
source and captured receipt. Separate engine, data and service subjects, retain
original conditions, and derive display labels through the shared formatter.

### Reviewed placement of current credits

Use the [shared attribution placement contract](./licensing.md#attribution-placement). Producer-captured per-binding source/product policies override reviewed exact licence defaults. The host renders permanent notices and one-action full details uniformly on map, content and image surfaces; do not infer placement from source names or hide mandatory notices using `maxVisible`. Preserve actual authors, publishers and API branding with each record/view.
