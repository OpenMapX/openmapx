---
title: Service manifest
description: The service.json schema for authoring an OpenMapX backend service — every field, grounded in the validator.
sidebar_position: 4
---

# Service manifest reference

Every backend service in OpenMapX — first-party or community — is described by a
single file: `service.json`. The manifest is the only thing the compose renderer
reads to turn a service into a docker-compose entry. It declares the container
image, its ports and mounts, the capabilities the service provides, the data it
consumes and produces, how (if at all) it is reachable from outside, and the
settings an operator can tune. There is no separate compose fragment to keep in
sync; the manifest is the whole contract.

This page is the field-by-field reference. For the model behind it — services
versus integrations, and how capabilities bind the two — see
[How it works](../overview/how-it-works.md). For operating services once they're
written, see [Managing services](../install/managing-services.md).

## Where it lives

A service named `valhalla` lives at `services/valhalla/service.json`. The
directory slug must equal the manifest's `id`, and any files the manifest
bind-mounts (config templates, icons) are resolved relative to that directory.
Community services install under `services/.community/<repo-hash>/<slug>/` and
follow the same layout.

The manifest is validated by a Zod schema in
`packages/core/src/services/manifest-schema.ts`. A file that fails validation is
dropped from the registry with an error; it never reaches the renderer. You can
validate and inspect a manifest from the CLI:

```bash
pnpm openmapx services list          # every manifest that validated
pnpm openmapx services get valhalla  # the full parsed manifest
```

## A complete example

Here is a realistic, annotated manifest — Valhalla, a routing engine that boots
from an OSM extract and is reachable on loopback:

```json
{
  "id": "valhalla",
  "name": "Valhalla",
  "version": "1.0.0",
  "description": "Multi-modal routing engine using OpenStreetMap data.",
  "license": "MIT",
  "quality": "built-in",
  "homepage": "https://valhalla.github.io/valhalla/",
  "documentation": "https://valhalla.github.io/valhalla/api/",

  "container": {
    "image": "ghcr.io/valhalla/valhalla-scripted",
    "tag": "latest",
    "expose": [8002],
    "environment": {
      "serve_tiles": "True",
      "build_elevation": "True"
    },
    "memory": "16g",
    "restart": "unless-stopped",
    "healthcheck": {
      "type": "http",
      "path": "/status",
      "port": 8002,
      "interval": "30s",
      "timeout": "10s",
      "retries": 5
    }
  },

  "provides": ["routing-engine"],
  "consumes": [{ "type": "osm-pbf", "mountAt": "/custom_files", "required": true }],

  "bindMounts": [
    { "source": "config/valhalla.json", "target": "/custom_files/valhalla.json", "readOnly": false }
  ],

  "configSchema": {
    "type": "object",
    "properties": {
      "build_elevation": { "type": "boolean", "default": true, "title": "Build elevation data" },
      "build_admins": { "type": "boolean", "default": true, "title": "Build admin boundaries" }
    }
  },

  "exposure": {
    "hostPorts": [{ "container": 8002, "host": 8002, "bindAddress": "127.0.0.1" }]
  },

  "ui": { "category": "routing", "icon": "icons/valhalla.svg" }
}
```

Only `id`, `name`, `version`, `quality`, and `container` (with `image` + `tag`)
are required. Everything else is optional and defaults to "not present."

## Identity

The top-level descriptive fields.

| Field | Type | Required | Notes |
| :--- | :--- | :---: | :--- |
| `id` | string | yes | Must match `^[a-z0-9][a-z0-9-]*$`. Becomes the compose service name and must equal the directory slug. |
| `name` | string | yes | Human-readable label shown in the admin UI. |
| `version` | string | yes | Free-form, semver by convention. |
| `description` | string | no | Short tagline surfaced in the catalog and admin detail page. |
| `author` | string | no | Free-form attribution. |
| `license` | string | no | SPDX identifier by convention (`MIT`, `Apache-2.0`). |
| `homepage` | URL | no | Project homepage; validated as a URL. |
| `documentation` | URL | no | API/docs URL; validated as a URL. |
| `quality` | enum | yes | `built-in`, `community-verified`, or `community`. Display/catalog label only; the sandbox uses where the manifest was loaded from (see [Quality tiers](#quality-tiers)). |
| `platform` | string | no | Optional platform-version constraint a community manifest can declare against the OpenMapX core. |

## `container`

The image and its runtime knobs. Most fields map one-to-one onto docker-compose
service keys; the renderer copies them through.

| Field | Type | Notes |
| :--- | :--- | :--- |
| `image` | string | **Required.** Lowercase, no tag suffix — matches `^[a-z0-9]([a-z0-9._\-/])*$`. Put the version in `tag`. |
| `tag` | string | **Required.** The image tag (`latest`, `2.10.2`, `v3.6`); matches `^[a-zA-Z0-9._-]+$`. |
| `containerName` | string | Pin the compose container to a fixed name (`container_name`) instead of the derived `<project>-<service>-<n>`. Required only when another service addresses this one by bare name over the Docker CLI (the data-manager does this for `motis`, `motis-staging`, `motis-feed-proxy`). It blocks scaling, so use it sparingly. |
| `expose` | number[] | Container ports published on the internal `openmapx` network. Required if `exposure.proxy.enabled` is `true`. |
| `networkAliases` | string[] | Extra DNS aliases on the `openmapx` network. Each must be a valid DNS label and may not collide with another service id or alias. Aliasing the service's own id is harmless. |
| `command` | string \| string[] | Container command. |
| `entrypoint` | string \| string[] | Container entrypoint. |
| `environment` | object (string→string) | Environment variables. Supports `${VAR}`, `${VAR:-default}`, and `${VAR:?error message}` interpolation, resolved at render time. |
| `envFile` | string[] | `env_file` pass-through. Relative paths under `infra/docker/` only. First-party services only: it can expose the deployment `.env`. Third-party services should use `configSchema`; secret fields arrive through `/run/secrets/<KEY>` with `<KEY>_FILE`. |
| `workingDir` | string | Working directory inside the container. |
| `user` | string | Run-as user, e.g. `"${UID:-1000}:${GID:-1000}"`. |
| `shmSize` | string | Shared-memory size, e.g. `"1g"`. |
| `memory` | string | Memory limit, e.g. `"16g"`, `"512m"`. |
| `restart` | enum | `no`, `on-failure`, `always`, or `unless-stopped`. |
| `capAdd` | string[] | Linux capabilities to add, from a fixed allowlist; unknown strings are rejected. First-party services may request the full allowlist (`NET_ADMIN`, `SYS_ADMIN`, `IPC_LOCK`, …). Third-party services are held to a stricter safe subset — escape-class caps (`SYS_ADMIN`, `SYS_PTRACE`, `SYS_TIME`, `SYS_CHROOT`, `NET_ADMIN`, `MKNOD`, `DAC_READ_SEARCH`, `IPC_LOCK`, `AUDIT_WRITE`) are rejected. |
| `capDrop` | string[] | Capabilities to drop. Accepts allowlisted names plus the special `"ALL"`. |
| `devices` | string[] | Host devices to pass through. Each entry must match `/dev/<name>`. **Forbidden for third-party services** — only first-party manifests may pass devices. |
| `privileged` | boolean | Run privileged. **Forbidden for third-party services.** |
| `networkMode` | enum | `bridge` or `host`. `host` is **forbidden for third-party services.** |
| `dependsOn` | array | Start-order dependencies — `{ "service": "<id>", "condition": "service_started" \| "service_healthy" }`. |
| `logging` | object | Compose logging — `{ "driver": "...", "options": { ... } }`. |
| `healthcheck` | object | See below. |

### `container.healthcheck`

The renderer translates this into a docker-compose `healthcheck` block. `http`
becomes a `curl` probe against `http://localhost:<port><path>`, `tcp` becomes a
port probe, and `exec` runs `command` directly.

```json
"healthcheck": {
  "type": "http",
  "path": "/status",
  "port": 8002,
  "interval": "30s",
  "timeout": "10s",
  "retries": 5,
  "startPeriod": "600s"
}
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `type` | enum | **Required.** `http`, `tcp`, or `exec`. |
| `path` | string | HTTP path to probe (`http` only). |
| `port` | number | Port to probe (`http`/`tcp`). |
| `command` | string \| string[] | Command to run (`exec` only). |
| `interval` | string | Probe interval, e.g. `"30s"`. |
| `timeout` | string | Per-probe timeout. |
| `retries` | number | Failures before "unhealthy." |
| `startPeriod` | string | Grace period during startup before failures count — useful for engines that build an index on first boot. |

## Capabilities and data flow

Three arrays express how a service fits into the stack: the abstract roles it
plays (`provides`), the prepared data it needs (`consumes`), and the data it
publishes for others (`produces`). The renderer matches a consumer's `consumes`
entry to another service's `produces` entry of the same `type` and emits a
hardlink-plan entry so the files are shared without copying.

### `provides`

Capability strings that integrations and other services match on. The routing
integration requires a `routing-engine`; whether that's Valhalla or OSRM is a
deployment choice, not a code change.

```json
"provides": ["transit-engine", "routing-engine"]
```

Each entry is either a bare string (the common case) or an object
`{ "capability": "routing-engine", "metadata": { ... } }`. The `metadata` slot
is reserved for future runtime layers; the platform does not read it today.

Well-known capabilities: `routing-engine`, `transit-engine`,
`transit-engine-staging`, `geocoder`, `tile-server`, `osm-query`, `database`,
`cache`, `proxy`, and the data-delivery roles `osm-data`, `gtfs-data`,
`tile-asset-data`. A community service may introduce new capabilities, but it
should namespace them as `<vendor>/<name>` (for example `acme/routing-engine`).
Non-conforming strings produce a non-blocking validation **warning**, not an
error — the manifest still loads, and the flag shows up in the admin UI and in
`pnpm openmapx services capabilities`.

### `consumes`

Prepared data the service expects to find mounted at a path. Each entry pairs
with a producer's `produces` entry of the same `type`.

```json
"consumes": [
  { "type": "tile-mbtiles", "mountAt": "/data/mbtiles", "readOnly": true, "required": true },
  { "type": "osm-pbf", "mountAt": "/nominatim/data", "targetFilename": "data.osm.pbf" }
]
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `type` | string | **Required.** The data type to bind. |
| `mountAt` | string | **Required.** Absolute container path; no `..`. |
| `instance` | string | Optional producer-instance id for multi-instance types (e.g. one OSM extract per region). Omit to bind the default/only instance. |
| `targetFilename` | string | Optional fixed filename to expose inside the mount, for services with a hard-coded input name (Nominatim's `data.osm.pbf`). The producer dir must then hold exactly one file. |
| `readOnly` | boolean | Defaults to `false`. |
| `required` | boolean | When `true`, a missing producer makes the render fail. When absent/`false`, a missing producer just omits the mount. |

### `produces`

Data this service writes for consumers. `sourceDir` is relative to the
producer's data root. In practice the built-in producer for these types is the
`data-manager`.

```json
"produces": [
  { "type": "osm-pbf", "sourceDir": "data/osm" },
  { "type": "gtfs", "sourceDir": "data/gtfs" },
  { "type": "tile-fonts", "sourceDir": "data/tile-fonts" }
]
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `type` | string | **Required.** The data type produced. |
| `sourceDir` | string | **Required.** Directory (relative to the data root) the service writes to. |
| `instance` | string | Optional instance id when the same type is produced more than once. Must match `^[a-z0-9][a-z0-9-]*$`. |

Well-known data types include `osm-pbf`, `osm-pbf-bz2`, `osrm-graph`,
`otp-graph`, `motis-data`, `motis-staging-data`, `motis-feed-proxy-config`,
`gtfs`, `tile-mbtiles`, `tile-fonts`, `pelias-placeholder-data`,
and `pelias-whosonfirst-data`. New types validate fine as long as a producer and
a consumer agree on the string. A single service may ship multiple `produces`
entries of the same `type` only when each carries a distinct `instance`;
duplicate `(type, instance)` pairs are rejected.

## Storage

### `volumes`

Named Docker volumes for state that must survive container restarts (a database
on disk, an Overpass index).

```json
"volumes": [
  { "name": "openmapx-pgdata", "mountAt": "/var/lib/postgresql" },
  { "name": "openmapx-overpass-db", "mountAt": "/db", "backup": true }
]
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `name` | string | **Required.** Must match `^openmapx-[a-z0-9-]+$`. A third-party service must use `openmapx-<serviceId>-<suffix>` so it cannot attach a platform or another extension's volume. |
| `mountAt` | string | **Required.** Absolute container path; no `..`. |
| `readOnly` | boolean | Defaults to `false`. |
| `backup` | boolean | When `true`, included in `pnpm openmapx backup create`/`restore`/`list`. |

### `bindMounts`

Mount files from the service's own directory — or, for built-in services only, a
small whitelist of host references — into the container.

```json
"bindMounts": [
  { "source": "config/config.json", "target": "/data/config.json" },
  { "source": "@infra:data/photon", "target": "/photon/data", "readOnly": false },
  { "source": "@service:pelias:config/pelias.json", "target": "/code/pelias.json" },
  { "source": "@docker-socket", "target": "/var/run/docker.sock" }
]
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `source` | string | **Required.** See the source kinds below. Third-party relative sources are canonicalized at render time and must remain inside the service snapshot. |
| `target` | string | **Required.** Absolute container path; first-party services may use a Compose-variable reference, but third-party services may not. No `..`. |
| `readOnly` | boolean | Defaults to `true`. |
| `optional` | boolean | When `true`, the mount is silently dropped at render time if the host source is absent. Used for operator-supplied secrets declared once but materialized only when the file is dropped in place. Not allowed with Compose-variable sources. |

The `source` may be one of:

| Source kind | Available to | Behavior |
| :--- | :--- | :--- |
| Relative path (`config/foo.json`) | all qualities | Resolved against the service's own directory. No `..`, no absolute paths. |
| `@docker-socket` | **built-in only** | Mounts the host's `/var/run/docker.sock`. |
| `@service:<slug>:<rel-path>` | **built-in only** | Mounts a path from another built-in service's directory (shared config). The renderer fails fast if the named service is unknown or the path escapes its directory. |
| `@infra:<rel-path>` | **built-in only** | Resolves against `infra/docker/` — the directory the compose file renders into. Used to bind the shared `infra/docker/data/` tree. |
| `${VAR}` / `${VAR:-default}` | **first-party only** | Compose-variable reference passed through verbatim; Docker substitutes it at `up` time. Third-party manifests cannot let the deployment environment choose a host path. |

## `exposure`

By default a service is reachable only on the private `openmapx` network, by
service id (`http://valhalla:8002`). Nothing is published to the host or the
internet unless the manifest opts in, in one of two ways.

```json
"exposure": {
  "hostPorts": [
    { "container": 8080, "host": 8080, "bindAddress": "127.0.0.1" }
  ],
  "proxy": {
    "enabled": true,
    "pathPrefix": "/tiles",
    "stripPrefix": true,
    "middleware": ["tiles-cache@file"]
  }
}
```

### `exposure.hostPorts`

Publishes a container port on the host.

| Field | Type | Notes |
| :--- | :--- | :--- |
| `container` | number | **Required.** Port inside the container. |
| `host` | number | **Required.** Port on the host. |
| `protocol` | enum | `tcp` (default) or `udp`. |
| `bindAddress` | string | Recommended `127.0.0.1` (loopback). The admin install preview flags a non-loopback bind as **publicly accessible** before you confirm. |

### `exposure.proxy`

Attaches Traefik routing so a path prefix under your domain reaches the
container — the common case for HTTP services. Enabling the proxy requires
`container.expose` to declare at least one port (otherwise validation fails).

| Field | Type | Notes |
| :--- | :--- | :--- |
| `enabled` | boolean | **Required.** When `true`, requires `container.expose`. |
| `pathPrefix` | string | HTTP prefix Traefik routes here. Must match `^/[a-zA-Z0-9._\-/]*$`. |
| `stripPrefix` | boolean | If `true`, the prefix is stripped before forwarding. |
| `middleware` | string[] | Traefik middleware names (e.g. `tiles-cache@file`). |
| `priority` | number | Higher wins when rules overlap. Use a low value for catch-all routes. |
| `authRequired` | boolean | Reserved for a future forward-auth integration. |
| `additionalRoutes` | array | Extra routers pointing at the same backend. Each entry sets exactly one of `path` (exact match) or `pathPrefix`, plus optional `middleware`. |

## `configSchema`

A JSON Schema object describing operator-facing settings. The admin panel
renders a form from it, persists values to the database, and the resolver merges
them into the rendered `container.environment` so they reach the running service
as environment variables.

```json
"configSchema": {
  "type": "object",
  "properties": {
    "build_elevation": { "type": "boolean", "default": true, "title": "Build elevation data" },
    "build_admins": { "type": "boolean", "default": true, "title": "Build admin boundaries" }
  }
}
```

The form supports `boolean` (switch), `enum` (select), `string`/`number`/
`integer` (text input), and `format: "url"`. A `default` populates the form when
no value is persisted.

A property may also carry `"x-openmapx-secret": true` to mark it as sensitive.
Secret keys are excluded from the env/database cascade below; instead the admin
panel's credential vault stores them encrypted and the renderer materializes each
one as a file-based Docker `secret`, mounted into the container and read by the
service through a `<KEY>_FILE` environment variable. See the
[service credential vault](../administration/services-administration.md) for the
operator workflow.

Each declared key resolves through a three-layer cascade at render time, highest
priority first:

| Priority | Source | Where it lives |
| :---: | :--- | :--- |
| 3 | Environment variable | `SERVICE_<ID>_<KEY>` in `infra/docker/.env` |
| 2 | Database | the admin panel's per-service config form |
| 1 | Schema default | `configSchema.properties.<key>.default` |

The env-var name is `SERVICE_` + the uppercased service id (hyphens become
underscores) + `_` + the uppercased config key — for `valhalla` and key
`memory_limit`, that's `SERVICE_VALHALLA_MEMORY_LIMIT`. Environment variables
always win, which keeps Docker deployments predictable. Because the cascade runs
at render time, a changed value takes effect only after a re-render and apply;
see [Managing services](../install/managing-services.md#configuring-a-service)
for the full workflow.

## `envVars`

Documents environment variables an operator may need to provide. This is
documentation surfaced in the admin UI — it is **not** enforced.

```json
"envVars": [
  { "name": "POSTGRES_PASSWORD", "required": true, "description": "Database password" },
  { "name": "PHOTON_REGION", "required": false, "default": "planet" }
]
```

## `ownsSchema`

Declares the Postgres schema this service owns and migrates itself, idempotently,
on boot. The value must be a valid lowercase Postgres identifier (`[a-z_][a-z0-9_]*`).

```json
"ownsSchema": "conditions"
```

### Boot-migration pattern

When a service declares `ownsSchema`, it is responsible for creating and evolving
its schema during container startup — before it begins serving traffic. The
blessed pattern is a sequence of idempotent DDL statements run under the
service's own DB role:

```sql
CREATE SCHEMA IF NOT EXISTS conditions;
CREATE TABLE IF NOT EXISTS conditions.observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   text NOT NULL,
  observed_at timestamptz NOT NULL,
  geometry    geometry(Geometry, 4326) NOT NULL,
  payload     jsonb NOT NULL
);
```

**Platform contract**: the platform applies no migration and grants nothing. It
is entirely the service's responsibility to create and migrate its schema. A
service must write only under the schema it declares — cross-schema writes by a
community service are not permitted.

**Namespace isolation**: each service owns exactly one schema. If a service needs
multiple schemas, it should either consolidate them or be split into separate
services with separate manifests.

## `buildCommand`

An optional operator-facing build hook for engines that need a prepared graph or
tile set before they can boot. Built-in services declare the
`openmapx services build <id>` command here, and the CLI runs the matching
Dockerized build handler. Today this is used by `osrm`, `otp`, `motis`,
`pelias`, and `tileserver`.

```json
"buildCommand": "openmapx services build tileserver"
```

## `ui`

Hints for the admin catalog.

```json
"ui": { "category": "routing", "icon": "icons/valhalla.svg" }
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `category` | string | Groups the service in the catalog. Used today: `infrastructure`, `application`, `routing`, `transit`, `geocoding`, `tiles`, `osm-query`. |
| `icon` | string | Path to an icon under the service's directory. |

## Quality tiers

`quality` is a display and catalog label, not an authorization input. The
security boundary is provenance: the registry passes `firstParty: true` only
for manifests shipped in this repository's `services/` tree, and
`firstParty: false` for manifests discovered under `services/.community/`.
The validator enforces the invariant in both directions: a first-party
manifest must declare `quality: "built-in"`, and a third-party manifest may not
declare it. A manifest cannot grant itself first-party privileges by changing
this field.

| Origin | Sandbox |
| :--- | :--- |
| First-party (`services/`, `quality: "built-in"`) | May use first-party-only host privileges and special sources such as `@docker-socket`, `@service:`, `@infra:`, host networking, and privileged mode. |
| Third-party (`services/.community/`, `quality: "community"` or `"community-verified"`) | Identical sandbox for both labels: no host networking, privileged mode, devices, escape-class capabilities, `@`-special sources, deployment `envFile`, or Compose-variable bind paths; named volumes must use `openmapx-<serviceId>-<suffix>`, and network aliases may not collide. |

The third-party rules apply at validation and again at render time. Relative
bind sources are canonicalized so a symlink shipped in a community snapshot
cannot escape its service directory; the renderer also checks cross-service
volume and network-alias collisions. Operator-supplied configuration should
use `configSchema`; secret fields are delivered as `/run/secrets/<KEY>` with
`<KEY>_FILE` set rather than by exposing `infra/docker/.env`.

## Validation at a glance

The schema enforces, among other rules:

- `id` matches `^[a-z0-9][a-z0-9-]*$` and equals the directory slug.
- `image` matches `^[a-z0-9]([a-z0-9._\-/])*$` (no tag suffix); `tag` matches `^[a-zA-Z0-9._-]+$`.
- Volume names match `^openmapx-[a-z0-9-]+$`.
- Every `mountAt` and `target` is absolute and free of `..`.
- A `bindMounts.source` is a relative path, a known first-party special source, or a Compose-variable reference — nothing else. Third-party relative sources must remain inside their snapshot after canonicalization.
- `capAdd` entries come from the fixed capability allowlist; `devices` match `/dev/<name>`. Third-party services are further restricted to a safe capability subset and may not pass devices.
- `exposure.proxy.enabled: true` requires at least one `container.expose` port.
- Duplicate `(type, instance)` pairs in `produces` are rejected.
- Third-party services may not use host networking, privileged mode, host device pass-through, escape-class capabilities, `@`-special bind sources, deployment `envFile`, or Compose-variable bind paths. Their volume names and network aliases are isolated from platform-owned names.

Capability and data-type strings that are neither well-known nor namespaced
produce warnings rather than errors, so the manifest still loads.

## Where to go next

- **[Managing services](../install/managing-services.md)** — enable, render, run,
  configure, and expose the services you've written.
- **[How it works](../overview/how-it-works.md)** — the service/integration model
  and the capability binding that ties them together.
