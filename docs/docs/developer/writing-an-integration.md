---
title: Writing an integration
description: A hands-on walkthrough — scaffold a directory, write the manifest, implement setup(ctx), and package it as an installable community artifact.
sidebar_position: 5
---

# Writing an integration

This page builds your first integration from an empty directory to an
installable artifact. It assumes you have read the
[Integration system](./integration-system.md) concepts — the manifest, the
`IntegrationContext`, domains, and the loader-to-host lifecycle — and have a
working [development setup](./development-setup.md) with the API running under
hot reload. Here we put those concepts to work end to end.

The example throughout is a small **knowledge** provider that exposes one HTTP
route fetching sunrise and sunset times for a coordinate. It is deliberately
minimal: a manifest, one `setup(ctx)` function, a cache read-through, and
attribution metadata. The same skeleton scales up to a weather provider, a POI
data source, or a transit provider — the only thing that changes is which
registrar you call.

For the two data-rich domains with their own typed contracts and orchestration
rules, follow the dedicated guides once you have the basics here:

- [Data-source integrations](./data-source-integrations.md) — bike/car/scooter
  sharing, parking, fuel, EV charging, webcams.
- [Transit integrations](./transit-integrations.md) — stops, departures, trip
  planning, vehicle positions, and alerts.

## Scaffold the directory

An integration is just a directory. While you are developing, create it under
`integrations/` so the API loads it directly from TypeScript source — no build
step, and `pnpm dev`'s `node --watch` picks up your edits. We will move to a
packaged community artifact [later](#package-and-install-as-a-community-integration).

```bash
mkdir -p integrations/knowledge-sunrise-sunset/strings
cd integrations/knowledge-sunrise-sunset
```

A built-in integration in the monorepo also gets a tiny `package.json` so pnpm
treats it as a workspace member and resolves the framework packages. (A released
community artifact does not need one — see [packaging](#package-and-install-as-a-community-integration).)

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
      "license": "Proprietary (free with attribution)",
      "licenseUrl": "https://sunrise-sunset.org/terms",
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
  per-result attribution chips are generated from these entries, and a host-side
  completeness gate fails the commit if a generated table cell would be empty.
  Any integration with `backend.routes: true` is required to declare a
  `dataSources` entry per upstream API it calls. Keep `sourceId` stable and
  globally unique — renaming it orphans existing attribution.

### Declaring a backend dependency

Our example talks to a public HTTP API and needs no self-hosted service. When an
integration *does* need one — a routing engine, an Overpass server, PostGIS —
declare it under `requires`. Each entry names exactly one of `service` (a
specific service slug) or `capability` (any provider of that capability), and may
be `optional`:

```json
{
  "requires": [
    { "service": "valhalla", "optional": true }
  ]
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
the encrypted vault. Note that declaring *any* secret field makes the integration
refuse to load unless `OPENMAPX_SECRETS_KEY` is set — a missing key is a hard boot
error, not a silent degrade. The layered resolution of these values — defaults,
database, vault, `config.json`, and environment — is the config cascade, and the
environment override for a key follows the pattern
`INTEGRATION_<ID>_<KEY>` (id and key upper-cased, hyphens and camelCase to
underscores), for example `INTEGRATION_KNOWLEDGE_SUNRISE_SUNSET_API_KEY`.

## Implement `setup(ctx)`

`index.ts` exports a `setup(ctx)` function that the host calls once at load time,
passing the [`IntegrationContext`](./integration-system.md#the-integration-context).
This is the integration's entire interface to the platform — you never import the
API server, the database driver, or Redis directly. You register what you provide
and return.

For our route-only example, `setup` registers a single GET route under the
integration's prefix and uses the namespaced cache for a read-through:

```ts
import type { IntegrationContext } from "@openmapx/integration-framework";

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
      const url = `${API_BASE}?lat=${latNum}&lng=${lngNum}&formatted=0`;
      const body = await ctx.http.get<{ status: string; results: unknown }>(url);
      if (body.status !== "OK") {
        ctx.log.warn(`Sunrise-Sunset API status: ${body.status}`);
        throw new Error("Sunrise-Sunset data unavailable");
      }
      return body.results;
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
  user id is then available as `req.userId`.
- **`ctx.cache`** is a key-value store namespaced per integration
  (`int:<id>:<key>`), so you cannot collide with another integration's keys. Its
  `withCache(key, ttl, fn)` helper reads through on a miss and stores the result.
- **`ctx.http`** is a small `fetch` wrapper that can transparently cache GET
  responses in Redis when you pass a `{ cache: { ttl } }` option.
- **`ctx.log`** is a structured logger already tagged with the integration id.

`ctx` also exposes `secrets`, an optional `db` (present only when the manifest
requires `postgis`), `liveStore` for the shared POI keyspace, and an event bus —
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
domain do not hand-roll attribution: the framework turns your `dataSources`
entries into the canonical attribution shape, so credit metadata lives only in
the manifest. The two mobility contracts have extra rules (capability
self-description, coverage, priority) covered on their own pages.

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

Reload re-registers providers and routes and re-reads config and bindings. The
one thing it cannot do is *remove* a previously registered route or pick up new
backend code in a production process — ESM module imports are cached for the
process lifetime, so a production deployment needs a real restart for new backend
code. Confirm the integration is loaded and hit its route:

```bash
curl http://localhost:3001/api/integrations | jq '.integrations[].id'
curl "http://localhost:3001/api/integrations/knowledge-sunrise-sunset/times?lat=51.5&lng=-0.1"
```

You can validate the manifest at any point without restarting the server:

```bash
pnpm openmapx integrations validate knowledge-sunrise-sunset
```

:::note[Built-in versus community]
An integration under `integrations/` is **built-in**: it runs from workspace
TypeScript source, needs no build step, and ships in the repository. The rest of
this page covers turning the same directory into a **community** integration —
an installable, prebuilt artifact that runs from a bundle under
`custom_integrations/`. The runtime difference is detailed in the
[Integration system](./integration-system.md#built-in-versus-community).
:::

## Package and install as a community integration

To distribute your integration to other deployments, you publish it as a
prebuilt `.tar.gz` **artifact** and operators install it through the Store. The
API never compiles code at runtime — it consumes the bundle — so the artifact
must arrive fully built. The CLI is the only tool that builds; it uses esbuild to
produce the bundles and stamps per-bundle checksums into the archive.

### Build the artifact

A community integration lives in its own repository, with `manifest.json` and
`index.ts` at the root, just like the built-in layout (minus the workspace
`package.json`). From a source tree, package it in one step:

```bash
pnpm openmapx integrations package ./knowledge-sunrise-sunset \
  --out ./knowledge-sunrise-sunset.tar.gz
```

This builds `dist/backend/index.mjs` (from your `index.ts`) and, if you ship
frontend components, `dist/frontend/index.js`; writes an
`openmapx-artifact.json` with the platform version and per-bundle sha256
checksums; and tars the directory. The resulting archive contains the manifest,
the bundles, the artifact metadata, and your strings — but never a
`node_modules/` directory, which artifacts are forbidden to ship. Backend runtime
dependencies are bundled into `dist/backend/index.mjs`; the host exposes only
`@openmapx/core`, `@openmapx/core/server`, `@openmapx/integration-framework`, and
`@openmapx/place-ids` as externals, so do not bundle your own copies of those.

For a community integration, set `"quality": "community"` and declare the
platform version you build against, for example `"platform": "1.0"`. The host
refuses to load an artifact whose major version differs from the running
platform, or whose minor is lower.

### Install through the Store

Publish the `.tar.gz` at an HTTPS URL — a GitHub release works well — and an
administrator installs it from the admin Store, either from a catalog entry or by
pasting the artifact URL (with an optional sha256). The admin install path is
**artifact-only**: it does not accept Git source URLs, which keeps the API image
free of build tooling. For testing on a dev workstation, the CLI installs the
same artifact directly:

```bash
pnpm openmapx integrations install \
  https://github.com/you/openmapx-sunrise/releases/download/v1.0.0/knowledge-sunrise-sunset.tar.gz \
  --artifact --sha256 <hash>
```

The installer downloads, verifies the checksum if you pass one, extracts into a
staging area with hardened tar handling, validates the manifest and the artifact
contract, and atomically swaps the result into `custom_integrations/<id>/`. After
installing in production, restart the API so its backend bundle loads into a fresh
module cache:

```bash
pnpm openmapx services restart app-api
```

Installing, updating, removing, catalog sources, and the trust model are the
administrator's side of this and are documented in
[Community extensions](../administration/community-extensions.md). For the
broader picture of where integrations sit relative to services and capabilities,
see [How it works](../overview/how-it-works.md).

## A faster inner loop with the CLI

While iterating on a community integration outside the monorepo, the CLI can
install a local source directory — it stages the directory, runs the same build
the packager does, validates, and swaps it in:

```bash
pnpm openmapx integrations install ./knowledge-sunrise-sunset
pnpm openmapx integrations build knowledge-sunrise-sunset   # re-bundle after edits
pnpm openmapx integrations list                             # confirm it is installed
pnpm openmapx integrations remove knowledge-sunrise-sunset  # tear it down
```

Source installs are a developer convenience; production always goes through a
prebuilt artifact. The full command set lives in the
[CLI reference](./cli-reference.md).

## Where to go next

- **[Data-source integrations](./data-source-integrations.md)** — the typed
  contract and orchestration for external POI sources.
- **[Transit integrations](./transit-integrations.md)** — stops, departures,
  trip planning, and realtime overlays.
- **[Integration system](./integration-system.md)** — the manifest schema, the
  context, and the loader-to-host lifecycle in depth.
- **[Service manifest](./service-manifest.md)** — declaring a backing service
  your integration requires.
