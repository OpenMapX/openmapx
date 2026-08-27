---
title: Building an external extension
description: A from-scratch guide to building an OpenMapX integration and/or companion service in your own repository, using OpenConditions as the worked example.
sidebar_position: 6
---

# Building an external extension

This guide is for authors who want to ship an OpenMapX integration in their **own
repository** — not as a built-in inside the OpenMapX monorepo. OpenConditions
(`openconditions/openconditions`) is the running example throughout: it publishes
road-condition observations and needs both an installable presentation integration
and a companion service (the Fastify daemon that owns the data and API behavior).

If you are developing a built-in integration inside the monorepo instead, start
with [Writing an integration](./writing-an-integration.md) — the paths and
tooling differ.

## Overview

An **external extension** is one or both of:

- An **integration** — a manifest plus optional presentation assets. Community
  artifacts are declarative/frontend-only; app-api and data-manager reject
  backend and POI-source entry points instead of importing them with control-plane
  authority.
- A **companion service** — a separately containerized daemon described by a
  `service.json`, managed by the OpenMapX compose renderer, and registered in the
  host's service registry. Services do their own Postgres schema migrations and
  supply data that integrations consume.

The two dependency directions to keep in mind:

1. **OpenMapX → your integration**: app-api discovers its manifest and serves its
   approved presentation assets; it does not execute community server code.
2. **You → OpenMapX tooling**: use `@openmapx/extension-cli` to scaffold,
   validate, package, and assemble the signed component manifest. Runtime code
   stays in the service container.

The CLI is published under Apache-2.0 and designed for use outside this repository.

## Set up your repo

### Keep the integration artifact declarative

No runtime SDK is needed for an installable integration artifact. It contains a
manifest, localized strings, and optional safe static assets such as an SVG
preview. App-api does not import community server modules, and the web app does
not execute community scripts. Put all executable behavior in the companion
service described below.

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

This creates `integrations/conditions/` with `manifest.json`, `package.json`, and
`strings/en.json`, with `__ID__` and `__DOMAIN__` tokens substituted throughout.

## Write the integration metadata

Describe the feature, data flows, attribution, configuration keys, and companion
service requirements in `manifest.json`. Do not add `index.ts`, `index.js`,
`poi-sources.*`, `map-layer.tsx`, `legend.tsx`, `panel.tsx`, or `dist` runtime
bundles: packaging and installation reject them until an appropriate isolation
boundary exists.

### Validate the manifest

At any point:

```sh
openmapx-ext validate ./integrations/conditions
```

Exits non-zero and prints errors if the manifest is invalid.

## Presentation code is not currently installable

Custom `map-layer.tsx`, legend, and panel components are intentionally rejected.
Running them as same-origin scripts would grant the artifact access to browser
storage, the page DOM, and cookie-authenticated API calls. CSP does not contain
code the application deliberately authorizes. A future external-presentation
API must use a separate origin or equivalently isolated worker with a narrow,
versioned capability protocol. Until then, contribute a trusted built-in UI or
use existing host-rendered surfaces backed by the companion service.

## Package and install the integration

### Package the artifact

From your repo root, package the declarative integration:

```sh
openmapx-ext package ./integrations/conditions --out conditions.tar.gz
```

This validates that the source is declarative-only, generates artifact metadata,
and creates the archive.

#### What the archive contains

Packaging copies an explicit allowlist into a fresh staging area — it never
archives your source directory. Anything not on this list simply is not
collected, so a stray `.env`, key, or scratch file next to a declared file
cannot reach a release:

| Included | Limit |
| --- | --- |
| `manifest.json` (after schema validation) | — |
| `openmapx-artifact.json` (generated) | — |
| `dist/frontend/index.js`, `dist/backend/index.mjs` when permitted | — |
| `dist/licenses.json` (generated) | — |
| `strings/<locale>.json` matching `[a-z0-9-]{2,35}` | 100 files, 256 KiB each |
| The exact manifest-referenced SVG preview | 64 KiB |
| `LICENSE`, `LICENSE.txt`, `LICENSE.md`, `NOTICE`, `NOTICE.txt` | 1 MiB each |

Everything else is excluded: source and tests, source maps, `package.json`,
lockfiles, dotfiles and `.env*`, VCS data, `node_modules/`, caches, unreferenced
`assets/`, symlinks, hard links, sockets, and devices.

Packaging never writes into your source tree, and two builds from the same
source produce byte-identical archives.

Preview the exact contents before publishing:

```sh
openmapx-ext package ./integrations/conditions --out conditions.tar.gz --dry-run
```

`--dry-run` prints each included relative path with its size and the total byte
count, and writes nothing. If the manifest references a file outside the
contract, packaging fails naming that relative path instead of producing an
archive.

#### Service repositories

An extension's service repository is cloned under fixed budgets: HTTPS only, on
the allowlisted hosts, with no credentials, query string, or fragment in the
URL. Each clone is shallow and bounded to 120 seconds, 25,000 entries, 512 MiB
total, 64 MiB per file, and 512 bytes per path; symlinks and special files are
rejected rather than followed. Only the canonical credential-free URL and the
exact resolved commit are recorded.

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

The installer downloads, verifies the mandatory checksum, extracts into a staging area,
rejects runtime entry points, validates the manifest and artifact contract, and atomically swaps the result
into `custom_integrations/conditions/`. The bundled files persist there across
upgrades until you remove the integration.

For distribution, wrap the artifact in an [`extension.json`](#bundle-it-as-an-extension)
so an operator installs it from the **Extensions** store (or
`pnpm openmapx ext install <extension.json-url>`) — that's the recommended path,
and it's required once your extension also ships a companion service.

### Reload `app-api`

Community artifacts are declarative/frontend-only. Backend and POI-source
JavaScript is rejected because app-api and data-manager are privileged control
plane processes, not sandboxes; backend behavior must live in the companion
service described below. After a manual CLI install, restart the API so the new
manifest is discovered (the Extensions store performs a transactional reload):

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

### Declare readiness in the extension manifest

The companion service owns, migrates, and serves its data. Use the
`extension.json` `readiness.requires` list to make installation readiness depend
on that service. A community integration artifact cannot bridge the service into
app-api with `setup(ctx)`; exposing a new host-facing route or provider requires
either an existing versioned host protocol or a reviewed built-in adapter.
Version and document that boundary alongside the bundle.

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

**Runtime isolation.** Integration artifacts are declarative-only and require a
SHA-256 pin. Executable extension behavior runs in the separately sandboxed
service component; app-api, data-manager, and the same-origin web page do not
execute community integration modules.

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
  built-in `IntegrationContext` surface, community restrictions, and the
  loader-to-host lifecycle in depth.
