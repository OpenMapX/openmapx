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

If your integration contributes a frontend component, also externalize the React
surfaces the host provides:

```js
externals: [
  // ...server externals above...
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@openmapx/integration-framework/react",
]
```

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
      // ctx.db is present because we declared requires: [{ service: "conditions-ingest" }]
      const db = ctx.getRequiredService("conditions-ingest");
      return db.query(
        `SELECT id, source_id, observed_at, ST_AsGeoJSON(geometry) AS geom, payload
           FROM conditions.observations
          WHERE ST_Intersects(geometry, ST_MakeEnvelope($1::float, $2::float, $3::float, $4::float, 4326))
          ORDER BY observed_at DESC
          LIMIT 500`,
        bbox.split(",").map(Number),
      );
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
- **`ctx.getRequiredService(slug)`** resolves a declared service dependency;
  throw if it returns `undefined` and the dependency was not declared optional.

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

### Install through the admin Store or the CLI

Publish the `.tar.gz` at an HTTPS URL (a GitHub release works well). An operator
then installs it through the admin Store by pasting the artifact URL, or via the
CLI:

```sh
pnpm openmapx integrations install \
  https://github.com/openconditions/openconditions/releases/download/v1.0.0/conditions.tar.gz \
  --artifact --sha256 <hash>
```

The installer downloads, verifies the checksum, extracts into a staging area,
validates the manifest and artifact contract, and atomically swaps the result
into `custom_integrations/conditions/`. The bundled files persist there across
upgrades until you remove the integration.

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

### Install the service

Services install from a Git URL into the host's service registry:

```sh
pnpm openmapx repos add https://github.com/openconditions/openconditions.git
pnpm openmapx services enable conditions-ingest
pnpm openmapx compose render
pnpm openmapx services start conditions-ingest
```

After `start`, the compose renderer has already created the service's named
volumes; your boot migration runs and the Postgres schema is ready before the
API accepts traffic.

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

At load time the host resolves this and makes the service reachable through
`ctx.getRequiredService("conditions-ingest")`. If the service is not installed or
not healthy, the host refuses to load the integration (unless the entry is
`"optional": true`).

### The shared schema as the handoff

The companion service owns and migrates the `conditions` schema; the integration
queries it read-only. This is the only contract between the two — no IPC, no
internal HTTP, no shared code at runtime. The integration can evolve its read
queries independently of the service's write side, as long as both agree on the
table shapes.

### End-to-end install order

Installing a coupled extension for the first time:

1. `pnpm openmapx repos add <git-url>` — register the service repository.
2. `pnpm openmapx services enable conditions-ingest` — opt in the service.
3. `pnpm openmapx compose render` — regenerate the compose file.
4. `pnpm openmapx services start conditions-ingest` — bring the service up and
   run its boot migration.
5. `pnpm openmapx integrations install <artifact-url> --artifact --sha256 <hash>` —
   install the integration artifact.
6. `pnpm openmapx services restart app-api` — load the integration bundle.

Updates follow the same order: update the service (render + recreate), then
update the integration artifact and restart the API.

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

**Service secrets.** Credentials for companion services are supplied today via
environment variables in `infra/docker/.env` — there is no vault integration for
service containers yet. Document which env vars your service reads in the
manifest's `envVars` array so they appear in the admin UI.

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
