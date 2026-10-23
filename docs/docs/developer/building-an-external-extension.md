---
title: Building an external extension
description: "Scaffold, validate and package a declarative integration and companion service outside the OpenMapX repository."
sidebar_position: 6
---

# Building an external extension

Use this guide to publish a declarative integration artifact, a containerized
service, or an extension bundle containing both from your own repository.
Installed artifacts cannot execute backend or presentation JavaScript in
OpenMapX. A new provider or UI requires an existing host protocol or a reviewed
built-in adapter.

The examples use a hypothetical `conditions` integration and `conditions-ingest`
service. OpenConditions illustrates the service/adapter boundary: its service
runs separately, while the reviewed built-in `openconditions` integration reads
it using `OPENCONDITIONS_URL`. Installing arbitrary service metadata does not
create that bridge.

For in-tree TypeScript development, use [Writing an integration](./writing-an-integration.md).

Before starting, prepare:

- Node matching the CLI's engine requirement (currently Node 24 or later).
- An independent authoring directory and the matching standalone CLI version.
- A disposable OpenMapX host for installation testing, with separate Docker
  ports and data from any existing deployment.
- A documented host adapter or protocol if the service must expose data to the app.

## Overview

An **external extension** is one or both of:

- An **integration**: a manifest plus optional presentation assets. Community
  artifacts contain declarative metadata, localized strings and safe static
  assets. Both backend entry points and presentation scripts are rejected.
- A **companion service**: a separately containerized daemon described by a
  `service.json`, managed by the OpenMapX compose renderer, and registered in the
  host's service registry. Services do their own Postgres schema migrations and
  supply data that integrations consume.

The two dependency directions to keep in mind:

1. **OpenMapX → your integration**: app-api discovers its manifest and serves its
   approved presentation assets; it does not execute community server code.
2. **You → OpenMapX tooling**: use `@openmapx/extension-cli` to scaffold,
   validate, package, and assemble the component manifest. Runtime code
   stays in the service container.

The standalone CLI and `@openmapx/extension-contracts` are Apache-2.0 authoring
tools. Use a published version that is available in your registry, or build an
exact candidate tarball from the host checkout. Package version fields alone do
not establish publication or compatibility with a deployed host.

## Set up your repo

### Keep the integration artifact declarative

An installable integration artifact needs no runtime SDK. It contains a
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

During local qualification, build and install the candidate instead:

```sh
# In the OpenMapX checkout:
pnpm --filter @openmapx/extension-cli pack --out /tmp/extension-cli.tgz
# In your independent authoring project:
npm install -g /tmp/extension-cli.tgz
```

Then scaffold the integration directory:

```sh
openmapx-ext scaffold integration conditions --domain knowledge --out ./integrations
```

This creates `integrations/conditions/` with `manifest.json`, `package.json`, and
`strings/en.json`, a `CONTRIBUTOR-CONTRACT.md` authoring note, and a
`companion-response.example.json` response example, with `__ID__` and `__DOMAIN__`
tokens substituted throughout. The response example is for your companion
service; it is not a manifest field or an automatically consumed host protocol.
Authoring notes/examples are excluded from the packaged artifact's allowlist. The generated package has no OpenMapX workspace dependencies. Install the published development dependency with `npm install`, or install the exact candidate tarball in that generated directory during local qualification. Its `npm run validate` and `npm run package` scripts use the standalone CLI. Installed development dependencies remain outside the declarative artifact.

The scaffold also includes a project README and `.github/workflows/validate.yml`. For a standalone integration repository, make the generated directory the repository root. If you keep it under `integrations/` in a companion-service repository, use the [nested repository instructions](#add-author-ci) below.

### Add author CI

First create and commit a lockfile from the generated directory:

```sh
# After the matching CLI version is published:
npm install --ignore-scripts
```

For an unpublished candidate, use a repository-relative tarball instead:

```sh
mkdir -p tools
cp /tmp/extension-cli.tgz tools/extension-cli.tgz
npm install --save-dev --ignore-scripts ./tools/extension-cli.tgz
```

Commit `package.json`, `package-lock.json` and, for the candidate path, `tools/extension-cli.tgz`. Ignore `node_modules/`. The candidate stays in the authoring repository and is excluded from the integration artifact. Once a CLI release is available, replace the file dependency with the chosen published version, refresh the lockfile and remove the candidate tarball.

The generated workflow uses read-only repository permissions and pinned actions. On pull requests and pushes to `main`, it runs:

```sh
npm ci --ignore-scripts
npm run validate
npm run package
```

It uploads the resulting `../<integration-id>.tar.gz` as a seven-day Actions artifact for inspection. It does not publish a release, install an extension or use deployment credentials. A successful run proves authoring preflight and packaging, not host readiness. Test companion-service code in its own CI as well.

The workflow expects the integration at the repository root. For a nested layout, move it to the repository's root `.github/workflows/`, set `jobs.validate.defaults.run.working-directory` to the integration directory, and adjust the upload step's `path` relative to the repository root. For example, `integrations/conditions` produces `integrations/conditions.tar.gz`. Change the `main` branch filter if your repository uses another name. Enable the workflow only after its lockfile and any referenced candidate tarball are committed.

GitHub discovers workflows only in the repository's root `.github/workflows/`; run-step defaults do not change action inputs. See [GitHub's workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [npm's clean-install requirements](https://docs.npmjs.com/cli/v11/commands/npm-ci/) when adapting this recipe.

## Write the integration metadata

Describe the feature, data flows, attribution, configuration keys, and companion
service requirements in `manifest.json`. Do not add `index.ts`, `index.js`,
`map-layer.tsx`, `legend.tsx`, `panel.tsx`, or `dist` runtime
bundles: packaging and installation reject them until an appropriate isolation
boundary exists.

### Validate the manifest

At any point:

```sh
openmapx-ext validate ./integrations/conditions
```

This checks the manifest and the same declarative-code and asset rules used by packaging, without writing an archive. Other inputs use `--kind service`, `--kind extension` or `--kind contributors` with a JSON file. Service checks always use community policy; contributor files contain canonical receipt arrays. Extension checks validate component references and the minimum protocol version. Invalid input exits non-zero with diagnostics.

The shared `@openmapx/extension-contracts` package supplies types, semantic validators and structural JSON Schemas for these inputs. Editor schemas supplement the runtime validators; they do not certify download access, installation authority or running-service readiness.

## Preserve companion-service contributor receipts

An existing versioned host protocol or a reviewed built-in adapter must expose
your service's data. Contributor metadata does not register a provider, create a
route, or authorize frontend code. Use the same portable [captured contributor
contract](./integration-system.md#captured-contributor-contract) as built-ins;
your service may emit this JSON without depending on an OpenMapX runtime SDK:

```json
{
  "id": "observation-1",
  "name": "Station reading",
  "value": 12,
  "contributors": [
    {
      "sourceId": "conditions-observations",
      "name": "Observation publisher",
      "licensing": {
        "version": 1,
        "bindings": [
          {
            "scope": "data",
            "subject": "Station readings",
            "license": { "kind": "spdx", "expression": "CC-BY-4.0" }
          }
        ]
      },
      "attributionText": "Required dataset notice"
    }
  ],
  "fieldContributors": {
    "name": [],
    "value": [
      {
        "sourceId": "conditions-observations",
        "name": "Observation publisher",
        "licensing": {
          "version": 1,
          "bindings": [
            {
              "scope": "data",
              "subject": "Station readings",
              "license": { "kind": "spdx", "expression": "CC-BY-4.0" }
            }
          ]
        },
        "attributionText": "Required dataset notice"
      }
    ]
  }
}
```

Use stable source IDs declared in source/privacy metadata and localized
disclosures; fill in the actual publisher, rights and required wording. `[]`
explicitly means this record/field has no externally owed credit; omit the field
only when captured provenance is unavailable. Never send `[]` merely
because exact provenance has not yet been implemented. Missing identities stay
unknown rather than borrowing every configured feed. Preserve each distinct
mandatory notice, including notices attached to an explicit canonical parent
source. `publisher` is optional `{ "name": "...", "url": "..." }`; homepage,
retrieval time and notes are optional strings. `licensing` uses the validated
[shared licence metadata contract](./licensing.md), including captured custom
definitions in your extension namespace. Flat display-label fields are unsupported.

Capture metadata before upstream acquisition and retain it in service caches,
validation, copies, DTOs and responses. Each row/cell/feature owns its actual
source; a mixed collection's overall source list cannot establish a cell's
supplier. Field maps preserve complete container/child ownership, including
empty child overrides. Views project only actual displayed fields/items and
geometry channels. A rights/audit dependency list may include other inputs and
must remain separate from selected display lineage.

For GeoJSON/MVT, serialize the canonical receipt as JSON text in
`properties._mapAttributions`; preserve field-specific metadata required by the
reviewed adapter. The trusted host uses shared validation/copy helpers and the
same geometry/raster visibility machinery. Malformed arrays fail validation;
canonical `[]` remains authoritative; missing exact evidence cannot trigger
whole-domain or toggle fallback. The host sanitizes required HTML and validates
links during rendering. Receipt validation alone never makes arbitrary HTML
safe. Callbacks, code, rendering certificates and host capabilities are not
valid contributor payload fields and must not execute.

Conformance tests should exercise the service's real retained/pruned results,
malformed metadata, explicit empty receipts, field/container ownership and
required notices. Keep per-file Commons author/license/file-page identity when
serving photographs; generic Wikimedia source metadata cannot recover those
requirements. Test the reviewed host adapter as well: a source manifest's
presence or a companion service's health is not proof that its data was shown.

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

Packaging copies an explicit allowlist into a fresh staging area: it never
archives your source directory. Anything not on this list simply is not
collected, so a stray `.env`, key, or scratch file next to a declared file
cannot reach a release:

| Included                                                           | Limit                   |
| ------------------------------------------------------------------ | ----------------------- |
| `manifest.json` (after schema validation)                          | :                       |
| `openmapx-artifact.json` (generated)                               | :                       |
| `dist/licenses.json` (generated when dependency notices are found) | :                       |
| `strings/<locale>.json` matching `[a-z0-9-]{2,35}`                 | 100 files, 256 KiB each |
| The exact manifest-referenced SVG preview                          | 64 KiB                  |
| `LICENSE`, `LICENSE.txt`, `LICENSE.md`, `NOTICE`, `NOTICE.txt`     | 1 MiB each              |

Everything else is excluded: source and tests, source maps, `package.json`,
lockfiles, dotfiles and `.env*`, VCS data, `node_modules/`, caches, unreferenced
`assets/`, symlinks, hard links, sockets, and devices.

Packaging never writes into your source tree, and two builds from the same
source and resolved dependency-notice inputs produce byte-identical archives.

Preview the exact contents before publishing:

```sh
openmapx-ext package ./integrations/conditions --out conditions.tar.gz --dry-run
```

`--dry-run` prints each included relative path with its size and the total byte
count, and writes nothing. If the manifest references a file outside the
contract, packaging fails naming that relative path instead of producing an
archive.

#### Service repositories

The operations agent clones an extension's service repository under fixed
budgets: HTTPS only, on the allowlisted hosts, with no credentials, query
string, or fragment in the URL. Each clone is shallow and bounded to 120
seconds, 25,000 entries, 512 MiB total, 64 MiB per file, and 512 bytes per path;
symlinks, submodules and special files are rejected rather than followed. Only
the canonical credential-free URL and the exact resolved commit are recorded.

The agent reads `service.json` files up to four directory levels deep, skipping
dot-directories and dependency folders such as `node_modules`; a directory with
a `service.json` is one service, and nothing below it is searched. A
repository must provide at least one service, each with a unique id that no
built-in or other installed service already uses. The manifests of all installed
community services together may not exceed 768 KiB.

For a distributable artifact, set `"quality": "community"` in your manifest and
declare the platform version you build against:

```json
{
  "quality": "community",
  "platform": "1.0"
}
```

The host requires the same extension-protocol major and a host minor at least as high as the declared requirement. Product versions, npm package versions, protocol versions and archive schema versions are separate identities. Protocol `1.0` does not imply a supported OpenMapX product release.

### Install through the Extensions store or the CLI

Publish the `.tar.gz` at an HTTPS URL (a GitHub release works well). For a
standalone integration the quickest dev/manual path is the CLI installer:

```sh
pnpm openmapx integrations install \
  https://github.com/<owner>/<repo>/releases/download/v1.0.0/conditions.tar.gz \
  --artifact --sha256 <hash>
```

The installer downloads, verifies the mandatory checksum, extracts into a staging area,
rejects runtime entry points, validates the manifest and artifact contract, and atomically swaps the result
into `custom_integrations/conditions/`. The bundled files persist there across
upgrades until you remove the integration.

For distribution, wrap the artifact in an [`extension.json`](#bundle-it-as-an-extension)
so an operator installs it from the **Extensions** store (or
`pnpm openmapx ext install <extension.json-url>`): that's the recommended path,
and it's required once your extension also ships a companion service. The operator
CLI previews before queuing an install. For host ports, first inspect
`pnpm openmapx ext preview <extension.json-url>` and deliberately pass its exact
fingerprint with `--host-port-confirmation <fingerprint>`. See the
[operator confirmation workflow](../administration/community-extensions.md) for
snapshot changes, request limits and queued-job handling.

### Reload `app-api`

Community artifacts are declarative-only. Backend
JavaScript is rejected because app-api is a privileged control plane process,
not a sandbox; backend behavior must live in the companion
service described below. After a manual CLI install, restart the API so the new
manifest is discovered (the Extensions store performs a transactional reload):

```sh
pnpm openmapx services restart app-api
```

## Test in a local development host

Keep the authoring project outside the host checkout. Use a separate OpenMapX checkout and a Docker environment reserved for this test; another checkout alone does not isolate Docker ports or volumes. Record the host commit, CLI version and artifact SHA-256 with your test results so the same inputs can be tested again.

### Start a host for metadata and configuration testing

Follow [Development setup](./development-setup.md) for the host prerequisites and environment files. In a fresh checkout:

```sh
git clone https://github.com/OpenMapX/openmapx.git openmapx-extension-host
cd openmapx-extension-host
git rev-parse HEAD
pnpm install --frozen-lockfile
cp infra/docker/.env.example infra/docker/.env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Use the Node and pnpm versions pinned by that checkout. Set fresh `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` and `DATA_MANAGER_AUTH_TOKEN` values in `infra/docker/.env`; the CLI checks deployment secrets even when rendering the dev preset. Match the password in `apps/api/.env`'s `DATABASE_URL`, set its `BETTER_AUTH_SECRET`, and retain the generated Redis password-file wiring described in Development setup. Do not use example passwords or point this host at an existing deployment's database.

Start the disposable database/cache and initialize the development schema:

```sh
pnpm openmapx services start --preset dev
pnpm --filter @openmapx/api db:push
```

Run the API and web app in separate terminals from the host checkout:

```sh
pnpm --filter @openmapx/api dev
```

```sh
pnpm --filter @openmapx/web dev
```

Open `http://localhost:3000` and register a test account. From the host checkout, bootstrap the [first administrator](../administration/users-and-access.md#the-first-admin); if SMTP is not configured, the verification command lets that local account sign in:

```sh
pnpm openmapx users verify your-test-email@example.org
pnpm openmapx users promote your-test-email@example.org
```

Sign out and back in after promotion. Keep `OPENMAPX_CUSTOM_INTEGRATIONS_DIR` unset for this recipe so the API and installer both use the checkout's `custom_integrations/` directory.

### Install and repeat the authoring loop

In the independent authoring project, validate and package your integration:

```sh
npm run validate
npm run package
```

Compute the artifact digest with a portable Node command:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' /absolute/path/conditions.tar.gz
```

From the host checkout, install that exact artifact and inspect the installed version:

```sh
pnpm openmapx integrations install /absolute/path/conditions.tar.gz --artifact --sha256 <digest>
pnpm openmapx integrations list
```

Restart the host-run API process manually; the Docker `services restart app-api` command does not restart a process launched by `pnpm dev`. Reload the browser and check the integration's metadata, configuration, disclosures and declared static assets under **Admin → Integrations**. Update the authoring source, package again, reinstall the new artifact and repeat the restart. This is a copy/install loop, not a live symlink to the source directory.

Keep a previous artifact and digest to test rollback by reinstalling those exact bytes. To remove the test integration, run `pnpm openmapx integrations remove <integration-id>` from the host checkout, then restart the host-run API again. Stop the disposable infrastructure with `pnpm openmapx services stop --preset dev` when finished; that command retains its data.

### Test companion services and complete bundles

The dev preset runs only the database and cache. It does not qualify Docker service installation, configuration forwarding, readiness, updates or recovery. For those checks, use a separate full stack from [Getting started](../install/getting-started.md), the complete `extension.json` input described below, and the supported host protocol or reviewed adapter that consumes the service's data.

Validate service and bundle documents before installing them:

```sh
openmapx-ext validate ./services/conditions-ingest/service.json --kind service
openmapx-ext bundle --input extension.source.json --out extension.json
openmapx-ext validate extension.json --kind extension
```

Sign in as an administrator on that disposable full stack, open **Admin → Extensions → Install from URL**, and enter the controlled HTTPS URL of your `extension.json`. Review and confirm the community extension preview. Use the authenticated UI for this full-stack recipe: the default container stack does not expose the API on the host's `localhost:3001`, which is where the `ext` CLI defaults to connecting.

Verify configuration forwarding, actual service readiness and displayed data, required attribution, reinstall/update behavior, and recovery from an intentionally failing candidate. A manifest-only integration does not register a provider or introduce executable UI. Passing author CI or showing a healthy manifest does not establish those runtime results.

## Add a companion service

An integration that needs its own database, daemon, or ingest loop ships a
**companion service**: a separately containerized process the compose renderer
manages alongside the rest of the stack.

### Scaffold the service

```sh
openmapx-ext scaffold service conditions-ingest --out ./services/conditions-ingest
```

This creates `services/conditions-ingest/service.json` with the `id` substituted,
ready to fill in. Replace the image, health port, schema name and capabilities
with your service's actual values before validation.

### Declare `ownsSchema`

A service that creates and migrates its own Postgres schema declares it in
`service.json`:

```json
{
  "id": "conditions-ingest",
  "name": "Conditions ingest",
  "version": "1.0.0",
  "quality": "community",
  "ownsSchema": "conditions",
  "container": {
    "image": "ghcr.io/your-org/conditions-ingest",
    "tag": "1.0.0",
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

Before installation, add the actual `container.digest` (`sha256:<64 lowercase
hex digits>`) of your published image. The portable service validator accepts a
manifest without it, but host admission rejects an unpinned community image.
Use the digest produced by your build/publish workflow; the illustrative image
above is not a deployable artifact.

`ownsSchema` must be a valid lowercase Postgres identifier
(`[a-z_][a-z0-9_]*`). The platform applies no migration and grants nothing,
it is entirely your service's responsibility.

### Migrate idempotently on boot

Your service must create and evolve its schema during container startup, before
it begins serving traffic. For an initial schema, use idempotent DDL:

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
binds. Later versions need ordered migrations for changes such as types, constraints
and data backfills. Use a migration ledger and appropriate locking;
`CREATE TABLE IF NOT EXISTS` alone does not upgrade an existing table.

Each service declares one owned schema. Cross-schema writes by a community
service are outside the contract. `ownsSchema` creates no database role, grants
or network access. Community services run on isolated networks and cannot reach
platform Postgres by default. Provision an explicit reviewed database connection
and a restricted role before using this SQL. The OpenConditions network bridge
is a specific built-in exception, not a capability every extension receives.

### How the service gets installed

A service ships in an extension bundle (next section). When the operator installs
the bundle, the orchestrator clones your service repo at the pinned ref into the
host's service registry, enables the service, renders compose, and starts the
container within one queued job. Named volumes provide persistence where declared. Your service must gate its
own readiness on completed migrations; Compose startup alone does not prove
that its schema or the consuming API is ready. The bundle is the unit of installation; no separate service-repository
registration is needed.

## Wire them together

### Declare readiness in the extension manifest

The companion service owns, migrates, and serves its data. Use the
`extension.json` `readiness.requires` list to make installation readiness depend
on that service. A community integration artifact cannot bridge the service into
app-api with `setup(ctx)`; exposing a new host-facing route or provider requires
either an existing versioned host protocol or a reviewed built-in adapter.
Version and document that boundary alongside the bundle.

### Bundle it as an extension

A coupled extension uses one `extension.json` to identify the integration
artifact by SHA-256 and each service repository by ref. A tag or branch can
move between previews; use a commit SHA for reproducible publication. An omitted
ref resolves to HEAD at installation. The host records the resolved commit. Emit it with
the authoring CLI:

```sh
openmapx-ext bundle \
  --id conditions --name "Conditions" --version 1.0.0 --platform 1.0 \
  --service "https://github.com/<owner>/<repo>,v1.0.0,conditions-ingest" \
  --integration "https://github.com/<owner>/<repo>/releases/download/v1.0.0/conditions.tar.gz,<sha256>,conditions" \
  --out extension.json
```

To author configuration and readiness along with the components, use a complete source document:

```sh
openmapx-ext bundle --input extension.source.json --out extension.json
openmapx-ext validate extension.json --kind extension
```

The input can include `config` and `readiness`. Do not combine `--input` with metadata or component flags. Validation finishes before the output file is written.

Publish `extension.json` at an HTTPS URL after the artifacts and service revision it references are available. Catalog verification binds the exact manifest bytes to a SHA-256 pin; a moving URL or catalog inclusion alone does not establish verified trust. Updates to verified content require reviewed pins for the new version. Direct-URL installs remain community trust. See [Community extensions](../administration/community-extensions.md) for the current catalog and update rules.

### End-to-end install

The operator queues one installation job for the bundle. It installs the
components, applies configuration, starts services and reloads integrations:

```sh
pnpm openmapx ext preview https://example.com/extension.json
# Inspect the complete output. If it exposes host ports:
pnpm openmapx ext install https://example.com/extension.json --host-port-confirmation <fingerprint>
# Without host ports, omit the confirmation option. Catalog IDs also work.
```

A queued response is acceptance only. Inspect Activity for the terminal result.
The installer records rollback/recovery state, but installation is not a single
atomic transaction across files, configuration, containers, application state
and service-owned database migrations. Failed or unknown host application can
require reconciliation. Design migrations and test recovery accordingly.

For the operator, updating is `pnpm openmapx ext update <id>` (or the **Update**
action in the admin panel, offered once the store sees your newer release); it
applies the new component set as one job. The companion service remains
responsible for schema compatibility and migration recovery. Something installed directly by URL (not via a
catalog) is updated by re-running `pnpm openmapx ext install <newer extension.json url>`.
For a catalog update with host ports, run `pnpm openmapx ext preview <id>` first,
review the current commit, bindings, source trust and full security rating, then
use `pnpm openmapx ext update <id> --host-port-confirmation <fingerprint>`.
Install/update obtain another preview and refuse missing or mismatched port
confirmation before writing. A changed snapshot requires new deliberate review;
there is no automatic consent or retry. Preview may fetch and stage repositories.

Every critical advisory blocks preview, admission and execution until cleared,
regardless of advisory `maxVersion`. Install/update/remove print a validated queued
job ID (HTTP 202); check **Admin → Activity** for completion. The CLI does not watch
jobs. Reads use 30-second deadlines, preview and writes 180 seconds. A timeout is
ambiguous and does not cancel host work; check Activity before deliberately
retrying. Respect 429 `Retry-After` for the independent preview and shared
install/update buckets, each one request per 30 seconds. After an explicit
`ext preview`, allow the preview bucket's limit before invoking install/update:
those commands obtain another fresh preview and exit on 429 without retrying.

## Caveats

**Runtime isolation.** Integration artifacts are declarative-only and require a
SHA-256 pin. Executable behavior runs in a separate service container subject to
the [community service restrictions](./service-manifest.md#quality-tiers).
App-api, data-manager and the same-origin web page do not execute community
integration modules. Network isolation still permits outbound internet traffic
and any explicitly reviewed built-in bridge connections.

**Platform-version compatibility.** The host rejects an integration whose
declared protocol major differs from the host, or whose required minor exceeds the host’s minor. Use exactly `major.minor`; legacy range strings such as `>=1.0.0` must be corrected to `1.0`. Pin a `platform` field in your
`manifest.json` and test against each OpenMapX release before publishing a new
artifact.

**Bundle persistence.** Installed integration bundles live under
`custom_integrations/<id>/` on the host. This directory is a bind-mount that
survives container restarts; removing the integration with
`pnpm openmapx integrations remove <id>` deletes the integration artifact. For a
bundle managed by the Extensions store, use `pnpm openmapx ext remove <id>` so
component ownership and installed-extension bookkeeping are updated together.
Neither command is a schema rollback for the companion service.

**Service secrets.** Declare operator-facing non-sensitive settings in `configSchema`;
the renderer forwards resolved values into the service environment. `envVars`
documents expectations but does not pass the deployment `.env` into a community
container. Community Compose interpolation is disabled. Sensitive credentials
should instead be declared as `configSchema` properties marked
`"x-openmapx-secret": true`: the admin panel's credential vault encrypts them and
the renderer mounts each as a file-based Docker `secret`, which your service reads
through the matching `<KEY>_FILE` environment variable. See
[`configSchema`](./service-manifest.md#configschema).

## See also

- **[Service manifest](./service-manifest.md)**: the full `service.json` schema:
  `ownsSchema`, `provides`, `consumes`, `volumes`, `bindMounts`, quality tiers,
  and security constraints.
- **[Community extensions](../administration/community-extensions.md)**: the
  operator's view: installing, updating, removing, catalog sources, and the trust
  model.
- **[Integration system](./integration-system.md)**: the manifest schema, the
  built-in `IntegrationContext` surface, community restrictions, and the
  loader-to-host lifecycle in depth.

Attribution placement follows the [shared placement contract](./licensing.md#attribution-placement). Capture reviewed binding policies with actual records; declarative metadata cannot authorize code or usage rights. Unknown agreements remain visible, and source/product overrides require dated evidence. Image authors, frame branding and per-view credits stay adjacent.
