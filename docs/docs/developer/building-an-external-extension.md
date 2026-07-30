---
title: Building an external extension
description: A from-scratch guide to building an OpenMapX integration and/or companion service in your own repository, using OpenConditions as the worked example.
sidebar_position: 6
---

# Building an external extension

This guide is for authors who want to ship an OpenMapX integration in their **own
repository** — not as a built-in inside the OpenMapX monorepo. OpenConditions
(`openconditions/openconditions`) is the running example throughout: it publishes
road-condition observations and needs both an installable integration (the API
surface inside OpenMapX) and a companion ingest service (the Fastify daemon that
owns the data).

If you are developing a built-in integration inside the monorepo instead, start
with [Writing an integration](./writing-an-integration.md) — the paths and
tooling differ.

## Overview

An **external extension** is one or both of:

- An **integration** — a manifest + `setup(ctx)` bundle that the OpenMapX
  `app-api` loads and runs in-process. Integrations register routes, providers,
  and UI components; they reach the outside world through the
  `IntegrationContext` the host injects, never by importing the API server or the
  database driver directly.
- A **companion service** — a separately containerized daemon described by a
  `service.json`, managed by the OpenMapX compose renderer, and registered in the
  host's service registry. Services do their own Postgres schema migrations and
  supply data that integrations consume.

The two dependency directions to keep in mind:

1. **OpenMapX → your integration**: the `app-api` discovers, loads, and runs your
   integration bundle. Your code never touches the host internals; it only speaks
   through the context.
2. **You → OpenMapX packages**: you consume `@openmapx/extension-sdk` (types and
   helpers) as a dev dependency at build time. The host injects the actual
   `@openmapx/integration-framework` at runtime — you never bundle it.

Both the SDK and the CLI are published under Apache-2.0 and designed to be used
outside this repository.

## Set up your repo

### Install the SDK

Add the SDK as a dev dependency. It provides `IntegrationContext` types, a few
authoring helpers, and the test mock — all you need to write and type-check an
integration outside the monorepo:

```sh
npm i -D @openmapx/extension-sdk
```

### Mark host-injected packages as externals

The host provides several packages at runtime and expects your bundle to treat
them as externals — it will fail to load a bundle that ships its own copy. Add
these to your bundler's external list (esbuild, Rollup, Vite, or equivalent):

```js
// esbuild example
externals: [
  "@openmapx/core",
  "@openmapx/core/server",
  "@openmapx/integration-framework",
  "@openmapx/place-ids",
]
```

If your integration contributes a frontend component (a map overlay written in
React — see [Add a map overlay](#add-a-map-overlay)), also externalize the React
+ map surfaces the host provides:

```js
externals: [
  // ...server externals above (including @openmapx/core)...
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@openmapx/integration-framework/react",
  "maplibre-gl",
]
```

The host resolves all of these to its own live singletons via the page's import
map, so your overlay shares the host's React, registry context, and maplibre
instance. Bundling your own copy breaks hooks/context and detaches popups from
the map.

Do **not** list `@openmapx/extension-sdk` as an external — that package is used
only at build time (types and helpers); the SDK inlines what it needs into your
bundle.

### Scaffold an integration

Install the standalone CLI:

```sh
npm install -g @openmapx/extension-cli
# or run without installing
npx @openmapx/extension-cli --help
```

Then scaffold the integration directory:

```sh
openmapx-ext scaffold integration conditions --domain knowledge --out ./integrations
```

This creates `integrations/conditions/` with a ready-to-edit `index.ts`,
`manifest.json`, `package.json`, and `strings/en.json`, with `__ID__` and
`__DOMAIN__` tokens substituted throughout.

## Write the integration

### Minimal `setup(ctx)`

`index.ts` exports a `setup(ctx)` function. Import the `IntegrationContext` type
from `@openmapx/extension-sdk` (not from `@openmapx/integration-framework` —
the SDK re-exports the type so your build is self-contained):

```ts
import type { IntegrationContext } from "@openmapx/extension-sdk";

export async function setup(ctx: IntegrationContext): Promise<void> {
  ctx.registerRoute("GET", "/observations", async (req, reply) => {
    const { bbox } = req.query as { bbox?: string };
    if (!bbox) {
      reply.status(400).send({ message: "bbox is required" });
      return;
    }

    const cacheKey = `conditions:observations:${bbox}`;
    const rows = await ctx.cache.withCache(cacheKey, 30, async () => {
      const service = ctx.getRequiredService("conditions-ingest");
      if (!service) throw new Error("conditions-ingest is unavailable");
      return ctx.http.get(`${service.url}/observations`, {
        params: { bbox },
        timeoutMs: 5_000,
      });
    });

    reply.send({ observations: rows });
  });
}
```

Key points:

- **`ctx.registerRoute(method, path, handler)`** mounts the route under your
  integration's prefix; the full path becomes
  `GET /api/integrations/conditions/observations`.
- **`ctx.cache.withCache(key, ttl, fn)`** reads through on a miss and stores the
  result for `ttl` seconds.
- **`ctx.getRequiredService(slug)`** returns a declared service's internal URL
  and state; handle `null` for an optional or unavailable dependency.

### Test it with the SDK mock

The SDK ships a `createMockIntegrationContext` factory so you can test `setup`
without a running OpenMapX instance:

```ts
import { createMockIntegrationContext } from "@openmapx/extension-sdk/testing";
import { setup } from "./index.js";

const ctx = createMockIntegrationContext({ config: {} });
await setup(ctx);

// assert what was registered
console.assert(ctx.registered.routes.some((r) => r.path === "/observations"));
```

The mock records every `registerRoute`, `registerProvider`, and similar call so
your tests can assert on them without spinning up a real host.

### Validate the manifest

At any point:

```sh
openmapx-ext validate ./integrations/conditions
```

Exits non-zero and prints errors if the manifest is invalid.

## Add a map overlay

If your extension draws on the map, it ships a `map-layer.tsx` frontend bundle.
The legend is the one part you can declare instead of writing, and the layer
selector entry is manifest-only either way:

```jsonc
{
  "domains": ["map-overlay"],
  "frontend": {
    "mapLayer": true,
    "layerSelector": {
      "group": "map-details",
      "labelKey": "myOverlay",
      "icon": "warning",
      "preview": "preview.svg"
    },
    "overlay": {
      "minZoom": 6,
      "legend": { "kind": "categorical", "title": "My overlay", "items": [{ "color": "#cc0033", "label": "High" }] }
    }
  }
}
```

Place the preview beside the manifest so the integration-root-relative path
resolves directly:

```text
integrations/
└── conditions/
    ├── manifest.json
    ├── preview.svg
    ├── index.ts
    └── strings/
        └── en.json
```

The preview must be an SVG no larger than 64 KiB. The package command includes
this static asset automatically. If the preview is omitted or cannot be loaded,
the layer selector displays its generic placeholder.

In `map-layer.tsx`, reach the map with `useHostMap()` from
`@openmapx/integration-framework/react`, register your credits so they appear in
the map credits strip, and externalize the React + `maplibre-gl` surfaces (see
[Mark host-injected packages as externals](#mark-host-injected-packages-as-externals)).
The full `frontend.overlay` schema and the community frontend runtime are
documented in
[Integration system → Map overlays](./integration-system.md#map-overlays).

An extension does not have to draw anything itself. OpenConditions is
backend-only: it declares no `frontend` block at all, publishing its road and
traffic feeds as `dataSources` under the `road-conditions` domain, and the
app's own overlays render and credit them.

## Package and install the integration

### Build the artifact

From your repo root, build and package the integration:

```sh
openmapx-ext package ./integrations/conditions --out conditions.tar.gz
```

This bundles `index.ts` into `dist/backend/index.mjs` (and `dist/frontend/index.js`
if you ship UI components), stamps per-bundle sha256 checksums into
`openmapx-artifact.json`, and creates the archive. The resulting `.tar.gz`
contains the manifest, bundles, artifact metadata, and strings — never a
`node_modules/` directory.

For a distributable artifact, set `"quality": "community"` in your manifest and
declare the platform version you build against:

```json
{
  "quality": "community",
  "platform": "1.0"
}
```

The host refuses to load a bundle whose major version differs from the running
platform, or whose minor is lower.

### Install through the Extensions store or the CLI

Publish the `.tar.gz` at an HTTPS URL (a GitHub release works well). For a
standalone integration the quickest dev/manual path is the CLI installer:

```sh
pnpm openmapx integrations install \
  https://github.com/openconditions/openconditions/releases/download/v1.0.0/conditions.tar.gz \
  --artifact --sha256 <hash>
```

The installer downloads, verifies the checksum, extracts into a staging area,
validates the manifest and artifact contract, and atomically swaps the result
into `custom_integrations/conditions/`. The bundled files persist there across
upgrades until you remove the integration.

For distribution, wrap the artifact in an [`extension.json`](#bundle-it-as-an-extension)
so an operator installs it from the **Extensions** store (or
`pnpm openmapx ext install <extension.json-url>`) — that's the recommended path,
and it's required once your extension also ships a companion service.

### Restart `app-api`

After installing, the integration's backend bundle is on disk but not yet loaded —
ESM module imports are cached for the process lifetime. Restart the API to bring
it in:

```sh
pnpm openmapx services restart app-api
```

## Add a companion service

An integration that needs its own database, daemon, or ingest loop ships a
**companion service** — a separately containerized process the compose renderer
manages alongside the rest of the stack.

### Scaffold the service

```sh
openmapx-ext scaffold service conditions-ingest --out ./services/conditions-ingest
```

This creates `services/conditions-ingest/service.json` with the `id` substituted,
ready to fill in.

### Declare `ownsSchema`

A service that creates and migrates its own Postgres schema declares it in
`service.json`:

```json
{
  "id": "conditions-ingest",
  "name": "OpenConditions ingest",
  "version": "1.0.0",
  "quality": "community",
  "ownsSchema": "conditions",
  "container": {
    "image": "ghcr.io/openconditions/openconditions",
    "tag": "latest",
    "expose": [4000],
    "healthcheck": {
      "type": "http",
      "path": "/health",
      "port": 4000,
      "interval": "30s",
      "timeout": "10s",
      "retries": 5,
      "startPeriod": "30s"
    }
  },
  "provides": ["conditions-ingest"]
}
```

`ownsSchema` must be a valid lowercase Postgres identifier
(`[a-z_][a-z0-9_]*`). The platform applies no migration and grants nothing —
it is entirely your service's responsibility.

### Migrate idempotently on boot

Your service must create and evolve its schema during container startup, before
it begins serving traffic. The blessed pattern is idempotent DDL:

```sql
CREATE SCHEMA IF NOT EXISTS conditions;

CREATE TABLE IF NOT EXISTS conditions.observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   text NOT NULL,
  observed_at timestamptz NOT NULL,
  geometry    geometry(Geometry, 4326) NOT NULL,
  payload     jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS conditions_observations_geometry_idx
  ON conditions.observations USING GIST (geometry);
```

Run these statements in your service's startup code before the HTTP listener
binds. A `CREATE … IF NOT EXISTS` approach lets you add columns in later versions
by appending `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements — each
migration step stays idempotent.

Each service owns exactly one schema. Cross-schema writes by a community service
are not permitted.

### How the service gets installed

A service ships in an extension bundle (next section). When the operator installs
the bundle, the orchestrator clones your service repo at the pinned ref into the
host's service registry, enables the service, renders compose, and starts the
container — all in one step. The renderer creates the service's named volumes
first, then your boot migration runs, so the Postgres schema is ready before the
API accepts traffic. There is no separate "register a service repo" step — the
bundle is the unit of installation.

## Wire them together

### Declare the dependency in the integration manifest

The integration must declare that it requires the companion service. Add a
`requires` entry to `manifest.json`:

```json
{
  "requires": [
    { "service": "conditions-ingest" }
  ]
}
```

At load time the host resolves this and makes the service descriptor reachable
through `ctx.getRequiredService("conditions-ingest")` (`serviceId`, internal
base `url`, and enabled state). If the service is not installed or
not healthy, the host refuses to load the integration (unless the entry is
`"optional": true`).

### Choose an explicit handoff contract

The companion service owns and migrates the `conditions` schema. It can expose
an internal HTTP API and the integration can call the descriptor's `url` through
`ctx.http`; this keeps the service's database private and is the preferred
community-extension boundary. A trusted integration that also declares the
platform PostGIS requirement may instead use `ctx.db` and read the owned schema,
but `getRequiredService()` itself is only service discovery — it is not a SQL
client. Whichever contract you choose, version and document it alongside the
bundle so the pinned service and integration evolve together.

### Bundle it as an extension

A coupled extension is distributed as one `extension.json` that pins every part —
the integration artifact by SHA-256, the service repo by Git ref. Emit it with
the authoring CLI:

```sh
openmapx-ext bundle \
  --id openconditions --name "OpenConditions" --version 1.0.0 --platform 1.0 \
  --service "https://github.com/openconditions/openconditions,v1.0.0,conditions-ingest" \
  --integration "https://github.com/openconditions/openconditions/releases/download/v1.0.0/conditions.tar.gz,<sha256>,conditions" \
  --out extension.json
```

Publish `extension.json` at an HTTPS URL — and point it at a **moving "latest
release"** location so updates flow from your releases, not from catalog edits.
The simplest way: attach `extension.json` to each GitHub release (regenerated so
`version` and the service `ref` are that release's tag) and use the stable
`https://github.com/<owner>/<repo>/releases/latest/download/extension.json` asset
url. List it **once** by opening a PR to the curated
[`openmapx/community-extensions`](https://github.com/openmapx/community-extensions)
catalog pointing `manifest` at that url (inclusion is what makes it a **verified**
entry). The store reads the version from your manifest, so **every later release
surfaces as an available update with no further catalog change**. (If you instead
pin the manifest url to a specific tag, updates stay gated behind a catalog edit —
useful when you want each version curated.)

### End-to-end install

The operator installs the whole bundle in one action — the orchestrator pins and
starts the service, installs the integration, and reloads the API atomically
(rolling back on failure):

```sh
pnpm openmapx ext install https://…/extension.json   # or by catalog id once listed
```

For the operator, updating is `pnpm openmapx ext update <id>` (or the **Update**
action in the admin panel, offered once the store sees your newer release); it
re-pins every part together so the coupled service, integration, and shared
schema stay version-consistent. Something installed directly by URL (not via a
catalog) is updated by re-running `pnpm openmapx ext install <newer extension.json url>`.

## Caveats

**In-process trust.** An integration bundle runs in the same process as `app-api`
with the same OS privileges. Install only extensions you trust. The `sha256`
checksum on install verifies the artifact has not been tampered with, but it does
not sandbox the code that runs inside it.

**Platform-version compatibility.** The host rejects an integration whose
declared `platform` major version differs from the running OpenMapX, or whose
minor is lower than the current minor. Pin a `platform` field in your
`manifest.json` and test against each OpenMapX release before publishing a new
artifact.

**Bundle persistence.** Installed integration bundles live under
`custom_integrations/<id>/` on the host. This directory is a bind-mount that
survives container restarts; removing the integration with
`pnpm openmapx integrations remove <id>` deletes it cleanly.

**Service secrets.** Non-sensitive service settings are supplied via environment
variables in `infra/docker/.env` — document which ones your service reads in the
manifest's `envVars` array so they appear in the admin UI. Sensitive credentials
should instead be declared as `configSchema` properties marked
`"x-openmapx-secret": true`: the admin panel's credential vault encrypts them and
the renderer mounts each as a file-based Docker `secret`, which your service reads
through the matching `<KEY>_FILE` environment variable. See
[`configSchema`](./service-manifest.md#configschema).

## See also

- **[Service manifest](./service-manifest.md)** — the full `service.json` schema:
  `ownsSchema`, `provides`, `consumes`, `volumes`, `bindMounts`, quality tiers,
  and security constraints.
- **[Community extensions](../administration/community-extensions.md)** — the
  operator's view: installing, updating, removing, catalog sources, and the trust
  model.
- **[Integration system](./integration-system.md)** — the manifest schema, the
  `IntegrationContext` surface, built-in versus community bundles, and the
  loader-to-host lifecycle in depth.
