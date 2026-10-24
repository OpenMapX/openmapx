---
title: Service manifest
description: "The service.json schema for authoring an OpenMapX backend service: every field, grounded in the validator."
sidebar_position: 4
---

# Service manifest reference

A `service.json` declares a backend container's image, ports, mounts,
capabilities, data requirements and operator settings. The Compose renderer
combines validated manifests with enabled-service selection, resolved
configuration and deployment settings to produce the stack.

Use this reference when adding or changing a service. For the service and
integration model, see [How it works](../overview/how-it-works.md). For enabling,
rendering and running a service, see [Managing services](../install/managing-services.md).
External authors should also follow [Building an external extension](./building-an-external-extension.md).

## Where it lives

A service named `valhalla` lives at `services/valhalla/service.json`. The
directory slug must equal the manifest's `id`, and first-party bind-mount
sources resolve relative to that directory. Community services install under
`services/.community/<repo-hash>/`, at most four directory levels into their
repository, and cannot declare bind mounts.

The ops-agent and the fixed CLI it runs do not read built-in manifests from the
host checkout. The ops-agent image's runtime bundle embeds every
`services/<id>/service.json` when it is built, so a release pins the manifests
together with the agent image, and the checkout's copies and their file
permissions do not decide what runs. The checkout still supplies everything a
manifest mounts from its service directory. The agent logs at startup, and the
fixed CLI's `check` (the admin panel's **Run diagnostics**) warns, when the
checkout's built-in manifests differ from the release's (missing, changed, or
not in the release). Rendering warns when an
enabled service mounts a file the checkout does not have. Run from source (the
host `pnpm openmapx`, tsx and tests), the code reads the checkout it runs from.
Adding a built-in service means adding its directory, its ID to
`RELEASE_BUILT_IN_SERVICE_IDS` and its manifest URL to
`packages/core/src/services/embedded-built-in-services.bundle.ts`; a test fails
until all three agree. Built-in integration manifests (`integrations/<id>/manifest.json`)
are embedded the same way, for their configuration schemas.

Community services are trusted by digest: the agent records the SHA-256 of
every manifest it validated when it installed a repository, and the agent and
its fixed CLI load only recorded manifests whose bytes still match
([community extensions](../administration/community-extensions.md#what-happens-on-install)).

The portable Zod schema and semantic validator live in
`packages/extension-contracts/src/service.ts`, with provenance restrictions in
`service-policy.ts`. Core re-exports them through
`packages/core/src/services/manifest-schema.ts`. A file that fails validation is
dropped from the registry with an error; it never reaches the renderer. You can
validate and inspect a manifest from the CLI:

```bash
pnpm openmapx services list          # every manifest that validated
pnpm openmapx services get valhalla  # the full parsed manifest
```

## A complete example

This excerpt uses the image pin and main settings from
`services/valhalla/service.json`. It shows the manifest shape; the shipped file
also contains traffic-watchdog wiring and a personal-data declaration. Consult
the shipped manifest when reproducing the complete service:

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
    "tag": "3.9.1",
    "digest": "sha256:6238809f9dc3057743d70a20efd3911ec38e458bfa13a0601909b58f68dfd956",
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
are required. Other fields are optional in the portable schema. Host installation adds
community admission rules, including a mandatory container digest and a
configuration schema accepted by the trusted renderer.

## Identity

The top-level descriptive fields.

| Field                    | Type         | Required | Notes                                                                                                                                                                                                                                                                                                         |
| :----------------------- | :----------- | :------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | string       |   yes    | Must match `^[a-z0-9][a-z0-9-]*$`. Becomes the compose service name and must equal the directory slug.                                                                                                                                                                                                        |
| `name`                   | string       |   yes    | Human-readable label shown in the admin UI.                                                                                                                                                                                                                                                                   |
| `version`                | string       |   yes    | Free-form, semver by convention.                                                                                                                                                                                                                                                                              |
| `description`            | string       |    no    | Short tagline surfaced in the catalog and admin detail page.                                                                                                                                                                                                                                                  |
| `author`                 | string       |    no    | Free-form attribution.                                                                                                                                                                                                                                                                                        |
| `license`                | string       |    no    | SPDX identifier by convention (`MIT`, `Apache-2.0`).                                                                                                                                                                                                                                                          |
| `homepage`               | URL          |    no    | Project homepage; validated as a URL.                                                                                                                                                                                                                                                                         |
| `documentation`          | URL          |    no    | API/docs URL; validated as a URL.                                                                                                                                                                                                                                                                             |
| `quality`                | enum         |   yes    | `built-in`, `community-verified`, or `community`. Display/catalog label only; the sandbox uses where the manifest was loaded from (see [Quality tiers](#quality-tiers)).                                                                                                                                      |
| `platform`               | string       |    no    | Descriptive service field. Extension bundle and integration manifests enforce the separate `major.minor` protocol requirement; this service schema accepts a string.                                                                                                                                          |
| `communityNetworkAccess` | service id[] |    no    | Audited first-party capability only. Explicitly attaches a built-in bridge service to the named community services' isolated networks while retaining `openmapx`. Rejected from community provenance at validation and render boundaries. Start with no entries; this is not a platform-network escape hatch. |

## `container`

The image and its runtime knobs. Most fields map one-to-one onto docker-compose
service keys; the renderer copies them through.

| Field             | Type                   | Notes                                                                                                                                                                                                                                                                                                                                                                                              |
| :---------------- | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image`           | string                 | **Required.** Lowercase, no tag suffix: matches `^[a-z0-9]([a-z0-9._\-/])*$`. Put the version in `tag`.                                                                                                                                                                                                                                                                                            |
| `tag`             | string                 | **Required.** The image tag (`latest`, `2.10.2`, `v3.6`); matches `^[a-zA-Z0-9._-]+$`.                                                                                                                                                                                                                                                                                                             |
| `digest`          | string                 | OCI manifest pin, `sha256:` followed by 64 lowercase hex digits. Optional in the portable schema; mandatory for installed community services. When present, the renderer uses `image:tag@digest`; `tag` remains required metadata.                                                                                                                                                                 |
| `containerName`   | string                 | Pin the compose container to a fixed name (`container_name`) instead of the derived `<project>-<service>-<n>`. Required only when another service addresses this one by bare name over the Docker CLI (the data-manager does this for `motis`, `motis-staging`, `motis-feed-proxy`). It blocks scaling, so use it sparingly.                                                                       |
| `expose`          | number[]               | Container ports exposed to the service's attached Compose network. Required if `exposure.proxy.enabled` is `true`.                                                                                                                                                                                                                                                                                 |
| `networkAliases`  | string[]               | Extra DNS aliases on the service's attached network (`openmapx` for built-ins, its isolated network for community services). Each must be a valid DNS label and may not collide with another service id or alias. Aliasing the service's own id is harmless.                                                                                                                                       |
| `command`         | string \| string[]     | Container command. First-party services may use Compose interpolation; community services render `$` literally.                                                                                                                                                                                                                                                                                    |
| `entrypoint`      | string \| string[]     | Container entrypoint. First-party services may use Compose interpolation; community services render `$` literally.                                                                                                                                                                                                                                                                                 |
| `environment`     | object (string→string) | Environment variables. First-party services support `${VAR}`, `${VAR:-default}`, and `${VAR:?error message}` interpolation passed to Docker Compose for deployment-time resolution. Community services render `$` literally and should use `configSchema` for operator-supplied settings.                                                                                                          |
| `envFile`         | string[]               | `env_file` pass-through. Relative paths under `infra/docker/` only. First-party services only: it can expose the deployment `.env`. Third-party services should use `configSchema`; secret fields arrive through `/run/secrets/<KEY>` with `<KEY>_FILE`.                                                                                                                                           |
| `workingDir`      | string                 | Working directory inside the container.                                                                                                                                                                                                                                                                                                                                                            |
| `user`            | string                 | Run-as user, e.g. `"${UID:-1000}:${GID:-1000}"`.                                                                                                                                                                                                                                                                                                                                                   |
| `shmSize`         | string                 | Shared-memory size, e.g. `"1g"`.                                                                                                                                                                                                                                                                                                                                                                   |
| `memory`          | string                 | Memory limit, e.g. `"16g"`, `"512m"`.                                                                                                                                                                                                                                                                                                                                                              |
| `restart`         | enum                   | `no`, `on-failure`, `always`, or `unless-stopped`.                                                                                                                                                                                                                                                                                                                                                 |
| `stopGracePeriod` | string                 | How long Docker waits for the container to stop before killing it (`stop_grace_period`), as a duration such as `30s`, `5m` or `1m30s`. Docker's default is 10 seconds; a service that must flush state on shutdown (a database writing its buffers at its shutdown checkpoint) needs longer, or every restart is a crash it recovers from.                                                         |
| `capAdd`          | string[]               | Linux capabilities to add, from a fixed allowlist; unknown strings are rejected. First-party services may request the full allowlist (`NET_ADMIN`, `SYS_ADMIN`, `IPC_LOCK`, …). Third-party services are held to a stricter safe subset: escape-class caps (`SYS_ADMIN`, `SYS_PTRACE`, `SYS_TIME`, `SYS_CHROOT`, `NET_ADMIN`, `MKNOD`, `DAC_READ_SEARCH`, `IPC_LOCK`, `AUDIT_WRITE`) are rejected. |
| `capDrop`         | string[]               | Capabilities to drop. Accepts allowlisted names plus the special `"ALL"`.                                                                                                                                                                                                                                                                                                                          |
| `devices`         | string[]               | Host devices to pass through. Each entry must match `/dev/<name>`. **Forbidden for third-party services**: only first-party manifests may pass devices.                                                                                                                                                                                                                                            |
| `gpu`             | object                 | Device reservation with `driver` (default `nvidia`), `count` (positive integer or `"all"`, default `"all"`) and `capabilities` (default `["gpu"]`). Requires a host and container runtime configured for that device driver.                                                                                                                                                                       |
| `privileged`      | boolean                | Run privileged. **Forbidden for third-party services.**                                                                                                                                                                                                                                                                                                                                            |
| `networkMode`     | enum                   | `bridge` or `host`. `host` is **forbidden for third-party services.**                                                                                                                                                                                                                                                                                                                              |
| `dependsOn`       | array                  | Start-order dependencies: `{ "service": "<id>", "condition": "service_started" \| "service_healthy" }`.                                                                                                                                                                                                                                                                                            |
| `logging`         | object                 | Compose logging: `{ "driver": "...", "options": { ... } }`.                                                                                                                                                                                                                                                                                                                                        |
| `healthcheck`     | object                 | See below.                                                                                                                                                                                                                                                                                                                                                                                         |

### Network isolation

Bridge-mode built-ins join the shared `openmapx` network and keep service-id
discovery there. Each community service instead receives exactly one dedicated
network named `openmapx-community-<normalized-service-id>` and never joins
`openmapx`. Different community services therefore cannot connect directly to
each other or to Redis, Postgres, app-api, data-manager, or other platform
peers. They retain ordinary outbound internet access through their own bridge.

An audited built-in may declare top-level `communityNetworkAccess` with exact
community service ids when a reviewed bridge needs to initiate a
connection to that community container. The renderer rejects built-in targets
and normalized-name collisions; a target that is not installed or not enabled
is skipped silently, so a bridge may name a community service before it is
installed. The capability is authorized from registry provenance
(`isBuiltIn` / `firstParty`), never from the manifest's self-declared
`quality`; a hand-built community `LoadedService` is rejected again at the
render boundary.

Four shipped built-ins opt in, all for OpenConditions, whose services own the
shared database's `conditions` schema: `postgis` (both OpenConditions services
connect to the database), `app-api` (its `openconditions` integration reads the
ingest service, and its crowd-reports relay forwards to the contributions API),
`data-manager` (its traffic cycle reads the ingest service) and `overpass` (the
ingest service queries a self-hosted Overpass). Two properties of this audited
exception are accepted, not accidental:

- The bridge is matched by service id, not by where the extension came from.
  Installing any extension whose service claims `openconditions-ingest` or
  `openconditions-contributions-api` gives that service the same network reach
  to these built-ins. Postgres still needs credentials the operator only gives
  OpenConditions, so the reach is to the port, not the data.
- The bridge is bidirectional. A network carries traffic both ways, so the
  OpenConditions containers can also open connections to `app-api` and
  `data-manager`, including their unauthenticated internal endpoints
  (`/internal/metrics`, the data-manager's `/live` and `/status`), which the
  proxy denies publicly.

If multiple community containers need to discover each other, define an
explicit reviewed multi-component service bundle instead of widening
platform-network access.

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

| Field         | Type               | Notes                                                                                                                      |
| :------------ | :----------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `type`        | enum               | **Required.** `http`, `tcp`, or `exec`.                                                                                    |
| `path`        | string             | HTTP path to probe (`http` only).                                                                                          |
| `port`        | number             | Port to probe (`http`/`tcp`).                                                                                              |
| `command`     | string \| string[] | Command to run (`exec` only). First-party services may use Compose interpolation; community services render `$` literally. |
| `interval`    | string             | Probe interval, e.g. `"30s"`.                                                                                              |
| `timeout`     | string             | Per-probe timeout.                                                                                                         |
| `retries`     | number             | Failures before "unhealthy."                                                                                               |
| `startPeriod` | string             | Grace period during startup before failures count: useful for engines that build an index on first boot.                   |

## Capabilities and data flow

Three arrays express how a service fits into the stack: the abstract roles it
plays (`provides`), the prepared data it needs (`consumes`), and the data it
publishes for others (`produces`). The renderer matches a consumer's `consumes`
entry to another service's `produces` entry of the same `type` and emits a
hardlink-plan entry so the files are shared without copying. The CLI applies
the plan after it renders. Before starting or recreating a service, the admin
panel reads the plan of the configuration it just applied from the operations
agent (`configuration.hardlinks.inspect`), since it lives in the host's
configuration generation, and has data-manager apply it. Data-manager mounts
only the data root, which confines the links and prunes to it.

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
error: the manifest still loads, and the flag shows up in the admin UI and in
`pnpm openmapx services capabilities`.

### Selection dependencies

`selectionDependencies` lists service IDs that must be enabled with this service:

```json
"selectionDependencies": ["postgis", "redis"]
```

The validator rejects duplicate IDs and self-reference. Service selection expands these dependencies transitively, also following
`container.dependsOn`. An uninstalled dependency produces a warning; visited IDs
prevent repeated expansion. This controls enabled selection. Use `container.dependsOn` separately
for Compose startup ordering and health conditions.

### `consumes`

Prepared data the service expects to find mounted at a path. Each entry pairs
with a producer's `produces` entry of the same `type`.

```json
"consumes": [
  { "type": "tile-mbtiles", "mountAt": "/data/mbtiles", "readOnly": true, "required": true },
  { "type": "osm-pbf", "mountAt": "/nominatim/data", "targetFilename": "data.osm.pbf" }
]
```

| Field            | Type    | Notes                                                                                                                                                                         |
| :--------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`           | string  | **Required.** The data type to bind.                                                                                                                                          |
| `mountAt`        | string  | **Required.** Absolute container path; no `..`.                                                                                                                               |
| `instance`       | string  | Optional producer-instance id for multi-instance types (e.g. one OSM extract per region). Omit to bind the default/only instance.                                             |
| `targetFilename` | string  | Optional fixed filename to expose inside the mount, for services with a hard-coded input name (Nominatim's `data.osm.pbf`). The producer dir must then hold exactly one file. |
| `readOnly`       | boolean | Defaults to `false`.                                                                                                                                                          |
| `required`       | boolean | When `true`, a missing producer makes the render fail. When absent/`false`, a missing producer just omits the mount.                                                          |

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

| Field       | Type   | Notes                                                                                                  |
| :---------- | :----- | :----------------------------------------------------------------------------------------------------- |
| `type`      | string | **Required.** The data type produced.                                                                  |
| `sourceDir` | string | **Required.** Directory (relative to the data root) the service writes to.                             |
| `instance`  | string | Optional instance id when the same type is produced more than once. Must match `^[a-z0-9][a-z0-9-]*$`. |

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
  { "name": "openmapx-overpass-db", "mountAt": "/db", "backup": true, "backupMode": "tar" }
]
```

| Field        | Type    | Notes                                                                                                                                                                          |
| :----------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | string  | **Required.** Must match `^openmapx-[a-z0-9-]+$`. A third-party service must use `openmapx-<serviceId>-<suffix>` so it cannot attach a platform or another extension's volume. |
| `mountAt`    | string  | **Required.** Absolute container path; no `..`.                                                                                                                                |
| `readOnly`   | boolean | Defaults to `false`.                                                                                                                                                           |
| `backupMode` | enum    | `tar` for a volume archive or `pg_dump` for a logical PostgreSQL dump. Required with `backup: true`.                                                                           |
| `backup`     | boolean | When `true`, included in `pnpm openmapx backup create`/`restore`/`list`.                                                                                                       |

A volume with `backup: true` must declare `backupMode: "tar"` or `"pg_dump"`.
The mode is invalid without `backup: true`. `pg_dump` additionally requires
literal safe `POSTGRES_USER` and `POSTGRES_DB` identifiers in
`container.environment`; deployment-variable references do not satisfy that
validation. Backup eligibility alone does not prove that an application-level
restore has been tested.

### `bindMounts`

First-party services mount files from their own directory or a small whitelist
of host references into the container. Community services may not declare any
`bindMounts` entry, including read-only entries; use a namespaced named volume
for persistent state instead.

```json
"bindMounts": [
  { "source": "config/config.json", "target": "/data/config.json" },
  { "source": "@infra:data/photon", "target": "/photon/data", "readOnly": false },
  { "source": "@service:pelias:config/pelias.json", "target": "/code/pelias.json" },
  { "source": "@docker-socket", "target": "/var/run/docker.sock" }
]
```

| Field      | Type    | Notes                                                                                                                                                                                                                                                          |
| :--------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`   | string  | **Required.** See the first-party source kinds below. Community services cannot declare this field because all community bind mounts are rejected.                                                                                                             |
| `target`   | string  | **Required.** Absolute container path; first-party services may use a Compose-variable reference. No `..`.                                                                                                                                                     |
| `readOnly` | boolean | Defaults to `true`.                                                                                                                                                                                                                                            |
| `optional` | boolean | First-party only. When `true`, the mount is silently dropped at render time if the host source is absent. Used for operator-supplied secrets declared once but materialized only when the file is dropped in place. Not allowed with Compose-variable sources. |

The `source` may be one of the forms below. These are validator capabilities,
not permission for an application service to take host authority. Repository
policy confines the Docker socket and registry credentials to `ops-agent`;
application services use typed operations-agent requests. Run
`pnpm check-ops-authority` when changing this wiring.

| Source kind                       | Available to         | Behavior                                                                                                                                                                |
| :-------------------------------- | :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relative path (`config/foo.json`) | **built-in only**    | Resolved against the service's own directory. No `..`, no absolute paths.                                                                                               |
| `@docker-socket`                  | **built-in only**    | Mounts the host's `/var/run/docker.sock`.                                                                                                                               |
| `@service:<slug>:<rel-path>`      | **built-in only**    | Mounts a path from another built-in service's directory (shared config). The renderer fails fast if the named service is unknown or the path escapes its directory.     |
| `@infra:<rel-path>`               | **built-in only**    | Resolves against `infra/docker/`: the directory the compose file renders into. Used to bind the shared `infra/docker/data/` tree.                                       |
| `${VAR}` / `${VAR:-default}`      | **first-party only** | Compose-variable reference passed through verbatim; Docker substitutes it at `up` time. Third-party manifests cannot let the deployment environment choose a host path. |

## `exposure`

By default a built-in service is reachable only on the private `openmapx`
network, by service id (`http://valhalla:8002`). A community service is reachable
only on its own isolated community network. Nothing is published to the host or
the internet unless the manifest opts in, in one of two ways.

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

| Field         | Type   | Notes                                                                                                                                  |
| :------------ | :----- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `container`   | number | **Required.** Port inside the container.                                                                                               |
| `host`        | number | **Required.** Port on the host.                                                                                                        |
| `protocol`    | enum   | `tcp` (default) or `udp`.                                                                                                              |
| `bindAddress` | string | Recommended `127.0.0.1` (loopback). The admin install preview flags a non-loopback bind as **publicly accessible** before you confirm. |

### `exposure.proxy`

Attaches Traefik routing so a path prefix under your domain reaches the
container: the common case for first-party HTTP services. It is unavailable to
community services because they cannot claim routes on the platform origin.
Enabling the proxy requires `container.expose` to declare at least one port
(otherwise validation fails).

| Field              | Type     | Notes                                                                                                                                                                                                                                |
| :----------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | boolean  | **Required.** First-party only; when `true`, requires `container.expose`.                                                                                                                                                            |
| `host`             | object   | Optional `{ "default": "tiles.{domain}", "configKey": "hostname" }`. The default is a validated hostname template; at most one `{domain}` token is allowed. `configKey`, if present, must name a declared non-secret string setting. |
| `pathPrefix`       | string   | HTTP prefix Traefik routes here. Must match `^/[a-zA-Z0-9._\-/]*$`.                                                                                                                                                                  |
| `stripPrefix`      | boolean  | If `true`, the prefix is stripped before forwarding.                                                                                                                                                                                 |
| `middleware`       | string[] | Traefik middleware names (e.g. `tiles-cache@file`).                                                                                                                                                                                  |
| `priority`         | number   | Higher wins when rules overlap. Use a low value for catch-all routes.                                                                                                                                                                |
| `authRequired`     | boolean  | Reserved for a future forward-auth integration.                                                                                                                                                                                      |
| `additionalRoutes` | array    | Extra routers pointing at the same backend. Each entry sets exactly one of `path` (exact match) or `pathPrefix`, plus optional `middleware`.                                                                                         |

A proxy with `host` routes by the resolved hostname and can also use a
`pathPrefix`. Without `host`, it uses the stack's normal domain. `stripPrefix`
requires a path prefix when host routing is configured. The renderer validates
the resolved hostname and rejects unresolved environment references in the
hostname override; it never accepts an arbitrary Traefik rule from that field.

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

Redis authentication is a platform-owned special case rather than a manifest
author capability. Compose rendering bootstraps a canonical 32-byte random
password under the host-only `0700` `infra/docker/secrets/` boundary, keeps the
source file readable for non-root containers, and mounts it only into Redis,
app-api, and data-manager. Those clients must read the exact bytes from
`REDIS_PASSWORD_FILE`; whitespace, malformed base64url, symlinks, non-regular
files, empty files, and oversized files fail closed. Rotation is performed only
through `pnpm openmapx compose rotate-redis-password --confirm-clients-stopped`,
after stopping app-api and data-manager. Password and derived ACL candidates are
both durable before the password commit, but their individual atomic renames are
sequential rather than a two-file transaction. Successful render/rotation paths
reread and reconcile the pair after concurrent changes. If a crash or target
integrity race interrupts the pair, keep clients stopped, repair or quarantine
the invalid ACL target, and run `pnpm openmapx compose render` before recreating
Redis. Wait for its authenticated health check before restarting either client;
never delete the password first or place it in a manifest URL, environment
value, command, label, or health-check text.

Each declared key resolves through a three-layer cascade at render time, highest
priority first:

| Priority | Source               | Where it lives                              |
| :------: | :------------------- | :------------------------------------------ |
|    3     | Environment variable | `SERVICE_<ID>_<KEY>` in `infra/docker/.env` |
|    2     | Database             | the admin panel's per-service config form   |
|    1     | Schema default       | `configSchema.properties.<key>.default`     |

The env-var name is `SERVICE_` + the uppercased service id (hyphens become
underscores) + `_` + the uppercased config key: for `valhalla` and key
`memory_limit`, that's `SERVICE_VALHALLA_MEMORY_LIMIT`. Nonempty environment overrides win. Empty values are treated as unset.
A schema default does not overwrite an existing `container.environment` default
for the same key; explicit database or environment settings still do. Because the cascade runs
at render time, a changed value takes effect only after a re-render and apply;
see [Managing services](../install/managing-services.md#configuring-a-service)
for the full workflow.

## `envVars`

Documents environment variables an operator may need to provide. This is
documentation surfaced in the admin UI: it is **not** enforced.

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
its schema before serving traffic. Run initial DDL under the service's own DB
role, and use ordered migrations for subsequent changes:

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
service must write only under the schema it declares: cross-schema writes by a
community service are not permitted.

**Namespace isolation**: each service owns exactly one schema. If a service needs
multiple schemas, it should either consolidate them or be split into separate
services with separate manifests.

The declaration does not create a database role, isolate its permissions or
connect an isolated community network to Postgres. Provision those through an
explicit reviewed deployment path and verify the role's grants. A generic
community service has no platform database reach by default.

## Personal-data storage declarations

`subjectData` uses the same declaration shape as an integration:
`storesPersonalData`, `strategy`, `registrationIds` and `operatorInstructions`.
The repository's `pnpm check-subject-data` requires it for built-in services,
although the portable service schema makes it optional. For a service without
personal-data storage:

```json
"subjectData": {
  "storesPersonalData": false,
  "strategy": "not_personal",
  "registrationIds": [],
  "operatorInstructions": null
}
```

Use `collector` with actual privacy-catalogue registration IDs for automated
handling, or `operator_task` with instructions for manual handling. This metadata
does not implement export, deletion or backup cleanup.

## `buildCommand`

An optional operator-facing build hook for engines that need a prepared graph or
tile set before they can boot. Built-in services declare the
`openmapx services build <id>` command here, and the CLI runs the matching
Dockerized build handler. Today this is used by `osrm`, `otp`, `motis`,
`pelias`, and `tileserver`.

```json
"buildCommand": "openmapx services build tileserver"
```

## `buildImages`

Helper images the build handler runs, keyed by role. Each entry needs an
`image`, a `tag`, and a mandatory `digest`, so a build host and a serving host
on the same revision run identical tooling. Renovate refreshes the digests the
same way it refreshes `container`.

```json
"buildImages": {
  "planetiler": {
    "image": "ghcr.io/onthegomap/planetiler",
    "tag": "0.10.2",
    "digest": "sha256:cf32202dbc001a9ab4bc11534b642b13de3798179817da8558e567a3d13dd403"
  }
}
```

## `ui`

Hints for the admin catalog.

```json
"ui": { "category": "routing", "icon": "icons/valhalla.svg" }
```

| Field      | Type   | Notes                                                                                                                                    |
| :--------- | :----- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `category` | string | Groups the service in the catalog. Used today: `infrastructure`, `application`, `routing`, `transit`, `geocoding`, `tiles`, `osm-query`. |
| `icon`     | string | Path to an icon under the service's directory.                                                                                           |

## Quality tiers

`quality` is a display and catalog label, not an authorization input. The
security boundary is provenance: the registry passes `firstParty: true` only
for manifests shipped in this repository's `services/` tree, and
`firstParty: false` for manifests under `services/.community/`, which the
operations agent validates before it installs a repository and again whenever
it reads the tree.
The validator enforces the invariant in both directions: a first-party
manifest must declare `quality: "built-in"`, and a third-party manifest may not
declare it. A manifest cannot grant itself first-party privileges by changing
this field.

| Origin                                                                                 | Sandbox                                                                                                                                                                                                                                                                                                                                                                   |
| :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First-party (`services/`, `quality: "built-in"`)                                       | May use first-party-only host privileges and special sources such as `@docker-socket`, `@service:`, `@infra:`, host networking, privileged mode, and narrowly reviewed `communityNetworkAccess`.                                                                                                                                                                          |
| Third-party (`services/.community/`, `quality: "community"` or `"community-verified"`) | Identical sandbox for both labels: one isolated per-service network; no `communityNetworkAccess`, bind mounts of any kind, host networking, privileged mode, devices, escape-class capabilities, deployment `envFile`, Compose-variable bind paths, or Traefik proxy routes; named volumes must use `openmapx-<serviceId>-<suffix>`, and network aliases may not collide. |

The third-party rules apply at validation and again at render time. Community
services must migrate persistent state to a namespaced named volume; operator
configuration should use `configSchema`, and secret fields are delivered as
`/run/secrets/<KEY>` with `<KEY>_FILE` set rather than by exposing
`infra/docker/.env`. The renderer also checks cross-service volume and
network-alias collisions.

Community services retain namespaced named-volume persistence and outbound
internet access through their isolated bridge network. They cannot reach the
private `openmapx` network, claim platform routes through Traefik, or interpolate
deployment environment variables: every `$` in community `command`,
`entrypoint`, environment keys or values, and exec health-check commands is
rendered literally.

## Validation at a glance

The schema enforces, among other rules:

- `id` matches `^[a-z0-9][a-z0-9-]*$` and equals the directory slug.
- `image` matches `^[a-z0-9]([a-z0-9._\-/])*$` (no tag suffix); `tag` matches `^[a-zA-Z0-9._-]+$`.
- Volume names match `^openmapx-[a-z0-9-]+$`.
- Every `mountAt` and `target` is absolute and free of `..`.
- A first-party `bindMounts.source` is a relative path, a known first-party special source, or a Compose-variable reference: nothing else. Community services may not declare `bindMounts`; use a namespaced named volume for persistent state.
- `capAdd` entries come from the fixed capability allowlist; `devices` match `/dev/<name>`. Third-party services are further restricted to a safe capability subset and may not pass devices.
- First-party `exposure.proxy.enabled: true` requires at least one `container.expose` port; community services cannot enable the platform proxy.
- Duplicate `(type, instance)` pairs in `produces` are rejected.
- `communityNetworkAccess` is first-party-only and names community service ids (uninstalled or disabled targets are skipped); community services never join `openmapx`, including when a manifest is handed directly to the renderer.
- Third-party services may not use bind mounts, host networking, privileged mode, host device pass-through, escape-class capabilities, deployment `envFile`, Compose-variable bind paths, platform proxy routes, or deployment-variable interpolation in Compose command, entrypoint, environment, and exec health-check fields. Their volume names and network aliases are isolated from platform-owned names.

Capability and data-type strings that are neither well-known nor namespaced
produce warnings rather than errors, so the manifest still loads.

## Configuration generation ownership and outcomes

CLI rendering and trusted ops configuration apply share a single writer boundary
in core. `withConfigurationGenerationWriter(infraDir, run, signal?)` acquires
`.trusted-config-writer` before reading inputs and holds it through staging,
initialization/pruning, pointer activation, follow-up files and cleanup. Its
callback may commit once. Standalone `commitConfigurationGeneration` and
`initializeConfigurationGenerations` acquire the same ownership.

Ownership uses exclusive directory creation on Linux/macOS local POSIX storage,
with a five-second acquisition deadline. There is no lease expiry or automatic
lock stealing. A killed process leaves the lock in place and subsequent writers
fail closed. Operator recovery must stop **all** CLI and agent writers before
inspecting and removing an interrupted lock; neither startup nor a contender
removes it. Network filesystems and Windows are not qualified. All writers must
run as the stack's user against the same physical infrastructure directory.

All API full-snapshot operations (`stack.render`, `serviceSelection.apply`,
`serviceConfig.apply`, `integrationConfig.apply`, `vault.apply`) require
`expectedCurrentRevisionId`; `null` deliberately means no applied pointer. The
API obtains it through typed `configuration.inspect` **before** preparing the
complete input. Observation and activation both acquire the shared writer
boundary. Activation compares the revision before any desired-selection effect
and again at pointer activation. CLI preparation reads the applied configuration
inside the same writer ownership, so it needs no separate observation request.

The condition is distinct from the candidate `revisionId` and manifest authority
revision. Strict operation parsing, its authenticated fingerprint and snapshot
claim bind it through execution. Missing conditions are rejected; there is no
compatibility parser. CLI renders create fresh identities even for repeated
content, preventing an old condition from becoming true again through content
reuse. A conflict leaves the current generation and its follow-up files intact.
The API observation returns only the current revision and bounded fingerprints
of named integration projections, never configuration values or service secrets.
A direct replay whose initial condition is no longer current conflicts; duplicate
accepted operations use the existing journal's settled result.

Configuration ops return `ConfigurationApplyResult`: `outcome: "committed"`
with the revision, enabled service IDs, `followUp: "complete" | "failed"` and
`cleanupFailed`, or `outcome: "not_committed"` with `reason: "conflict" | "busy" |
"failed"`, optional `currentRevisionId`, and `cleanupFailed`. The pointer rename
is the commit point; subsequent synchronization, follow-up or cleanup errors
retain commit evidence. A completed result after cancellation still carries that
evidence. Failed transport or lost journal evidence remains unknown, never proof
of non-commit. There are no automatic mutation retries.

The API's `applyTrustedConfigurationSnapshot({ payload,
expectedCurrentRevisionId, operationKey, signal? })` accepts a complete trusted
snapshot and requires an explicit condition. It returns the host outcome or
`outcome: "unknown"`, plus `publisherCleanupFailed` and `registryUpdateFailed`.
Normal `applyTrustedConfiguration` keeps its successful return shape and throws
`TrustedConfigurationApplyError` for incomplete outcomes. Callers may consider
restoring their own DB changes only with explicit non-commit evidence, and must
separately prove DB ownership. Compensation after a known commit must condition
an inverse of only proven named projections in the actually submitted snapshot
on the committed revision. Unrelated submitted fields must be retained. Conflict, unknown or
incomplete recovery requires reconciliation.

## Where to go next

- **[Managing services](../install/managing-services.md)**: enable, render, run,
  configure, and expose the services you've written.
- **[How it works](../overview/how-it-works.md)**: the service/integration model
  and the capability binding that ties them together.
