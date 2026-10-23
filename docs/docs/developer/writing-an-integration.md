---
title: Writing an integration
description: "A hands-on walkthrough for trusted built-in integrations: scaffold a directory, write the manifest, and implement setup(ctx) in the OpenMapX monorepo."
sidebar_position: 5
---

# Writing an integration

:::note
Building an integration in your **own repository**? See [Building an external extension](./building-an-external-extension.md) for the separate declarative-artifact and companion-service path.
:::

Build a trusted integration inside the OpenMapX monorepo with this walkthrough.
Start with a working [development setup](./development-setup.md), installed
workspace dependencies and an API process you can restart. Read the
[Integration system](./integration-system.md) reference for the manifest and
`IntegrationContext` contracts.

The example registers a sunrise/sunset HTTP endpoint in the `knowledge` domain.
It is route-only: it does not implement `KnowledgeProvider` or automatically
add content to a place panel. The fictional upstream at
`sun-times.example.org` makes the transport and response contract explicit.
Replace its URL, source metadata and response schema with a reviewed provider
before making live requests. The example will not return live data as written.

For a provider consumed by an existing orchestrator, use the matching contract:

- [Data-source integrations](./data-source-integrations.md): sharing, charging,
  parking, fuel and webcam categories.
- [Transit integrations](./transit-integrations.md): stops, departures, planning,
  vehicles and alerts.
- [Ride integrations](./ride-integrations.md): availability, quotes and handoffs.

Run the commands below from the repository root.

## Quick start: scaffold

Use the scaffold generator to start a built-in integration. It copies `integrations/_template/` into a new `integrations/<id>/` directory
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
under `integrations/` so the API loads it directly from TypeScript source: no
build step, and a new API process discovers it at startup. Community
extensions use a separate declarative artifact and companion-service contract;
do not convert this directory into one.

```bash
mkdir -p integrations/knowledge-sunrise-sunset/strings
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
    "@openmapx/integration-framework": "workspace:^",
    "zod": "^4.6.7"
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
    de.json          German translations required by repository policy
```

## Write the manifest

`manifest.json` is the declaration the host discovers and validates. It is the
single source of truth for the integration's identity, the domains it serves,
its service requirements, configuration form, attribution and
privacy metadata. The full schema is documented in the
[Integration system](./integration-system.md#the-manifest); here is a complete,
example for the route-only feature:

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
  "subjectData": {
    "storesPersonalData": false,
    "strategy": "not_personal",
    "registrationIds": [],
    "operatorInstructions": null
  },
  "healthCheck": {
    "type": "http",
    "url": "https://sun-times.example.org/times?lat=0&lng=0"
  },
  "dataSources": [
    {
      "sourceId": "sunrise-sunset",
      "name": "Example sun-times provider",
      "url": "https://sun-times.example.org/",
      "licensing": {
        "version": 1,
        "bindings": [
          {
            "scope": "service",
            "subject": "Example sun-times API",
            "license": { "kind": "unknown", "url": "https://sun-times.example.org/terms" }
          }
        ]
      },
      "commercialUse": "unknown",
      "providerCountry": "Unknown",
      "providerPrivacyUrl": "https://sun-times.example.org/privacy",
      "endUserExposure": "server-only",
      "personalData": true,
      "cookies": false,
      "dpaAvailable": false
    }
  ]
}
```

Check these fields before continuing:

- `id` must match `/^[a-z0-9][a-z0-9-]*$/` and the directory name. It sets the
  configuration namespace, environment prefix and `/api/integrations/<id>` route
  prefix.
- `domains` classifies the integration. Register a typed provider in `setup` if
  an orchestrator should consume it; a domain name alone registers no behavior.
- `backend.routes: true` advertises HTTP handlers. Set frontend flags only for
  UI components you implement.
- `dataSources` declares each actual upstream and its source/privacy metadata.
  `pnpm check-legal-tables` checks disclosure completeness. Route-only
  orchestrators can omit sources when they acquire no upstream data themselves;
  `backend.routes` does not universally require a source entry in the validator.
- `subjectData` declares this example's lack of personal-data storage. The
  separate `personalData: true` source field describes transmission of location
  queries. Do not infer one from the other.

The example's unknown service licence grants no usage rights. Replace the
illustrative terms/privacy links and confirm the service's conditions before
shipping. Keep source IDs stable so future acquisitions and disclosures refer
to the same supplier.

### Declaring a backend dependency

The example calls an external HTTP API and needs no self-hosted service.
Declare any required routing engine, Overpass server or PostGIS instance under
`requires`. Each entry names exactly one of `service` (a
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

Describe settings such as an API key, endpoint override or enabled flag with
`configSchema`. The admin panel renders it as a
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
refuse to load unless `OPENMAPX_SECRETS_KEY` is set: a missing key is a hard boot
error, not a silent degrade. The config cascade resolves defaults,
database values, vault secrets, `config.json` and environment overrides in that
order. An environment override follows the pattern
`INTEGRATION_<ID>_<KEY>` (id and key uppercased, hyphens replaced by
underscores). CamelCase is uppercased without added separators:
`apiKey` becomes `INTEGRATION_KNOWLEDGE_SUNRISE_SUNSET_APIKEY`. Use the exported
`integrationEnvVarName(id, key)` helper when displaying or generating a name.

### Helping operators obtain a key (`x-openmapx-setup`)

A credential field is only useful if the operator can actually get a value for
it. Mark every credential property `"x-openmapx-secret": true`, including fields
with `"format": "password"`, and attach `x-openmapx-setup` acquisition guidance.
The credential UI can then show a dashboard link, optional request email, cost
hint and short instructions next to the secret input. Secret fields belong on
credential surfaces; the ordinary configuration form must not render or submit
them:

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
self-service providers a `url` plus `steps` is enough. Keep steps short and imperative. For credential-keyed source integrations,
follow the source-ID-based key convention checked by `pnpm check-credential-keys`
and include setup guidance for every supported locale.

### Adding a map overlay

This walkthrough builds a trusted built-in route-only provider, so its `frontend`
flags are all `false`. A built-in map integration can ship a `map-layer.tsx`
(and optionally `legend.tsx` / `panel.tsx`), set the matching
`frontend.mapLayer` / `legend` / `panel` flag, add `domains: ["map-overlay"]`
and a `layerSelector` plus `overlay` entry when users should toggle it; a
layer that is ordinary map content (like published nearby places) declares only
`mapLayer` and manages its own lifecycle. A simple
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
Access host services through the context. Do not import the API server,
database driver or Redis directly. You register what you provide
and return.

For our route-only example, `setup` registers a single GET route under the
integration's prefix and uses the namespaced cache for a read-through:

```ts
import {
  httpError,
  type IntegrationContext,
  parseWgs84Point,
  QueryValidationError,
  resolveIntegrationContributors,
  scalarQuery,
  withContributors,
} from "@openmapx/integration-framework";
import { z } from "zod";

const API_BASE = "https://sun-times.example.org/times";
const CACHE_TTL = 21_600;
const responseSchema = z.object({
  status: z.literal("OK"),
  results: z.object({ sunrise: z.iso.datetime(), sunset: z.iso.datetime() }),
});

export function setup(ctx: IntegrationContext): void {
  const generation = new AbortController();
  ctx.onShutdown(async () => generation.abort());

  async function assertAllowed() {
    const denied = await ctx.getDisallowedSourceIds?.();
    if (generation.signal.aborted) throw httpError(503, "Integration retired");
    if (denied?.has("sunrise-sunset") || denied?.has(ctx.id)) {
      throw httpError(503, "Sun times disabled by data-use policy");
    }
  }

  ctx.registerRoute(
    "GET",
    "/times",
    async (req, reply) => {
      let point;
      try {
        point = parseWgs84Point(scalarQuery(req.query, "lng"), scalarQuery(req.query, "lat"));
      } catch (error) {
        if (error instanceof QueryValidationError) throw httpError(400, "Invalid coordinates");
        throw error;
      }
      if (!point) throw httpError(400, "Invalid coordinates");
      const [lng, lat] = point;
      await assertAllowed();

      const signal = req.signal
        ? AbortSignal.any([req.signal, generation.signal])
        : generation.signal;
      const result = await ctx.cache.withCache(
        `sun-times:${lat},${lng}`,
        CACHE_TTL,
        async (operationSignal) => {
          const captured = resolveIntegrationContributors(ctx, ["sunrise-sunset"]);
          const body = await ctx.http.get<unknown>(API_BASE, {
            params: { lat, lng },
            signal: operationSignal,
            timeoutMs: 4000,
            maxResponseBytes: 64 * 1024,
          });
          const parsed = responseSchema.safeParse(body);
          if (!parsed.success) throw httpError(502, "Invalid sun-times response");
          await assertAllowed();
          return withContributors(parsed.data.results, captured);
        },
        signal,
      );

      await assertAllowed();
      if (signal.aborted) throw httpError(503, "Request canceled");
      return reply.send(result);
    },
    { rateLimitTier: "expensive" },
  );
}
```

The host registers `GET /api/integrations/knowledge-sunrise-sunset/times`.
It prefixes each route with the integration ID. The example uses these context
services:

- **`ctx.registerRoute(method, path, handler, options?)`** mounts the route under
  the integration prefix. Pass `{ requireAuth: true }` to make the host reject
  unauthenticated callers with 401 before your handler runs; the authenticated
  user id is then available as `req.userId`. The incoming request's headers are
  forwarded as `req.headers` (`Record<string, string | string[] | undefined>`);
  Node lowercases every header name when parsing the request, so read
  `req.headers["if-none-match"]`, not `req.headers["If-None-Match"]`.
- **`ctx.cache`** is a key-value store namespaced per integration
  (`int:<id>:<key>`), so you cannot collide with another integration's keys. Its
  `withCache(key, ttl, fn, callerSignal?)` helper coalesces misses and passes
  an operation signal into the loader. Pass it to HTTP acquisition; caller
  cancellation need not cancel other callers sharing the same work.
- **`ctx.http`** is a small `fetch` wrapper that can transparently cache GET
  responses in Redis when you pass a `{ cache: { ttl } }` option.
- **`ctx.log`** is a structured logger already tagged with the integration id.

`ctx` also exposes `secrets`, an optional `db` (present only when the manifest
requires `postgis`), and an event bus,
the full surface is enumerated in the
[Integration system](./integration-system.md#services-available-to-integration-code).

### Registering a provider instead of a route

Routes are right for a small enrichment endpoint. For the data-rich domains, you
register a **provider** that implements that domain's typed contract, and the
domain orchestrator merges it with the other installed providers. The context has
one typed registrar per contract; a weather provider, for example, is a plain
object implementing the `WeatherProvider` interface:

```ts
import type { IntegrationContext, WeatherProvider } from "@openmapx/integration-framework";
import { createWeatherProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const provider: WeatherProvider = createWeatherProvider(ctx);
  ctx.registerWeatherProvider(provider);
}
```

`createWeatherProvider` is your implementation, not a framework export. Its
required `getCurrentWeather(coords, options?)` returns `Promise<WeatherResponse>`;
optional hourly/daily methods return their own `WeatherForecastResponse`
envelopes. Use `ctx.http`, captured contributors and shutdown handling inside the
factory.

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

When several integrations use the same upstream client identity, use its
explicit shared admission capability with the upstream's quota identity rather
than the integration's result-cache key. Treat missing capabilities and store
failure according to the provider's policy; process-local counters do not
coordinate replicas. See
[shared request admission](./integration-system.md#shared-request-admission)
for numeric policy, cooldown-only calls, cancellation and cache-clear semantics.

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
Both Panoramax gallery and street-level adapters use the shared
`panoramaxAuthor` helper from `@openmapx/core`: a top-level provider with the
producer role wins, then a nonblank string `geovisio:producer`. Missing creators
remain unknown. Wrap image acquisition with `capturePhotoProviderContributors`
or the explicit-source `captureStreetLevelProviderContributors` so file rights
and captured API/service obligations reach caches together.

Review orchestration uses `captureReviewProviderContributors` before reading
registered providers. The wrapper snapshots metadata before each await, resolves
the returned exact source or provider ID, and preserves supplied receipts/`[]`
and individual content licences. Views union only retained displayed reviews or
the displayed aggregate; current registry membership is not attribution evidence.
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

The host captures raster payload alpha alongside that same texture receipt.
Fully transparent decoded PNGs contribute no raster supplier. JPEG opacity and
bounded PNG alpha inspection use the acquired bytes, without another provider
request. Unknown alpha retains the captured supplier. Reload failures retain
both the old texture receipt and its opacity evidence.

Native basemap attribution is also host-owned. Capture the selected style and
source suppliers before asynchronous acquisition, then bind receipts to the
installed style/layer/source generation. Style-only backgrounds cannot create a
data-source receipt. Pending or failed installation keeps the previous installed
receipts, and retained source objects keep their original supplier receipts.
The host credits the conservative union of installed native receipts even when
layers are hidden, offscreen, out of zoom or covered by raster imagery. It
publishes on installation/style events without querying native features or
requesting repaint, and performs no exposure, mesh, clipping or tile-domain
analysis. Ordinary overlay and incident credits still use rendered record-level
contribution filtering and the shared 250 ms union query. See the
[host attribution contract](./integration-system.md#crediting-an-overlays-sources)
for installation lineage and the separate raster overlay adapter requirements.

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

Declare the level each semantic can support:

- `native`: the engine itself enforces the semantic.
- `emulated`: OpenMapX enforces it exactly, by orchestrating several engine
  calls. Verify the composed result against that semantic
  in the provider's tests.
- `approximate`: enforced arithmetically, but on travel times that do not vary
  with the departure instant. The wall clocks are estimates, and the app says so.
- `unsupported`: cannot be honored. A request needing it is rejected with the
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

Add `strings/en.json` and the repository's other supported locales next to
`index.ts`. The host loads these catalogs by convention. Consumers select the
locale; loading a catalog does not automatically translate arbitrary route data. The `name` and `description` power the admin list and
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
      "dataReceived": "Sunrise and sunset timestamps"
    }
  }
}
```

Key `dataSources` by the exact `sourceId` values from the manifest.

## Develop it in-tree

Start or restart the API after adding the directory. The development command
uses Node's module watcher; do not rely on it to notice newly discovered files,
JSON metadata or every transitive module edit. A process restart reloads the
complete module graph.

For manifest/configuration changes, the development-only endpoint can rebuild
the integration registry without restarting the process:

```bash
curl -X POST http://localhost:3001/api/integrations/reload
```

Reload stages providers, dynamic routes, lifecycle resources, and bindings in a
detached generation, then swaps it into service before retiring the old one. A
failed setup leaves the current generation serving. Trusted built-in entry imports
are cache-busted by entry-file mtime and size. This does not invalidate the full
transitive ESM graph. Confirm the integration is loaded
and hit its route:

```bash
curl http://localhost:3001/api/integrations | jq '.integrations[].id'
curl "http://localhost:3001/api/integrations/knowledge-sunrise-sunset/times?lat=51.5&lng=-0.1"
```

Expect the integration ID in the registry response. With a test HTTP fixture or
real reviewed upstream configured, `/times` returns ISO `sunrise` and `sunset`
values plus the captured `contributors` array. The fictional URL above cannot
provide that success response. Repeated coordinate keys or out-of-range values
return 400; a denied source returns 503; an invalid upstream body returns 502.

You can validate the manifest without restarting the server:

```bash
pnpm openmapx integrations validate knowledge-sunrise-sunset
```

Before contributing the integration, run its focused fixture tests and the
API package's `check-types`, including its integration TypeScript project. Test
coordinate rejection, denied sources, malformed upstream data, cache-hit
receipts and cancellation. Run the affected policy checks (`check-legal-tables`,
`check-data-flows`, `check-feed-ids`, `check-credential-keys` and
`check-subject-data`) as applicable. Route additions also require
`pnpm openapi:generate` and an inspected diff; see [API surface](./api-surface.md).
These checks do not replace a live upstream or rendered UI check when those are
part of the change. Follow the current [Contributing quality bar](https://github.com/OpenMapX/openmapx/blob/main/CONTRIBUTING.md#quality-bar).

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
import { useMap } from "@/integration-api/map/MapContext";

// Inside a React component:
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
map's rotation unchanged. A user who aligned the map to the street grid keeps
that alignment, so pass `{ bearing: 0 }` only for a view that has to be read
north-up. A structural test (`apps/web/src/lib/cameraFramingGate.test.ts`)
rejects raw `map.fitBounds`, `map.flyTo`, and `map.jumpTo` calls outside the few
files that own a standalone map.

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

## Where to go next

- **[Data-source integrations](./data-source-integrations.md)**: the typed
  contract and orchestration for map data sources: sharing, and the merged
  charging, parking, fuel, and webcam categories.
- **[Transit integrations](./transit-integrations.md)**: stops, departures,
  trip planning, and realtime overlays.
- **[Integration system](./integration-system.md)**: the manifest schema, the
  context, and the loader-to-host lifecycle in depth.
- **[Service manifest](./service-manifest.md)**: declaring a backing service
  your integration requires.
