---
title: Managing services
description: Choose, enable, render, run, configure, and expose OpenMapX backend services with the openmapx CLI.
sidebar_position: 4
---

# Managing services

Use the `openmapx` CLI to select, configure, and run backend containers. Each
service has a manifest under `services/<id>/service.json`; the renderer combines
the selected manifests into a Docker Compose stack. See
[How it works](../overview/how-it-works.md) for the service model.

Everything here runs through the `openmapx` CLI from the repo root:

```bash
pnpm openmapx <command> [args]
```

The CLI auto-loads `infra/docker/.env` before it does anything, so the same
`DOMAIN`, secrets, and per-service overrides a Docker deployment reads are in
scope for every command.

## Seeing what's available

`services list` validates installed first-party and community manifests and
prints a table:

```bash
pnpm openmapx services list
```

```
ID            Version  Quality   Provides                            Enabled
data-manager  1.0.0    built-in  osm-data,gtfs-data,tile-asset-data  yes
nominatim     1.0.0    built-in  geocoder                            no
photon        1.0.0    built-in  geocoder                            no
postgis       1.0.0    built-in  database                            yes
redis         1.0.0    built-in  cache                               yes
...
```

A manifest that fails validation is left out of the table and a warning is
printed to stderr. Narrow the list with filters:

```bash
pnpm openmapx services list --capability geocoder       # only services that provide a capability
pnpm openmapx services list --quality built-in          # built-in | community-verified | community
pnpm openmapx services list --enabled                   # only services in the current selection
```

To inspect one service's full manifest:

```bash
pnpm openmapx services get valhalla
```

List capabilities, shared data types, their providers, and consumers:

```bash
pnpm openmapx services capabilities
pnpm openmapx services capabilities --unrecognised      # flag non-standard capability names
```

## Enabling and disabling services

The set of services that participate in your deployment is the **selection**.
The default roots are `traefik`, `well-known`, `app-api`, `app-web`, `postgis`,
`redis`, and `data-manager`. Dependencies add `ops-agent` and `transitous-runner`.
Routing, geocoding, transit, OSM queries, and tiles are opt-in. Custom selections
replace the defaults; the core is not unconditionally added to every selection.

```bash
pnpm openmapx services enable valhalla photon          # add services to the selection
pnpm openmapx services disable osrm                    # remove services from the selection
```

These commands persist the change to `infra/docker/state/ops-agent/service-selection.json`, a
deployment file. For example, a selection retaining the default app roots is:

```json
{
  "selected": [
    "traefik",
    "well-known",
    "app-api",
    "app-web",
    "postgis",
    "redis",
    "data-manager",
    "valhalla",
    "photon"
  ]
}
```

You only list the **root** services you want. The renderer expands the rest
automatically from declared dependencies, data producers, and proxy exposure. To see both the roots you asked for and the effective set
after expansion:

```bash
pnpm openmapx services selected
```

The output names the source (`env`, `file`, or `default`), requested roots,
and effective set after dependency expansion.

The selection is resolved from the first source that's present, in this order:

1. an explicit `--services` flag on `compose render` / `compose up`
2. the `OPENMAPX_ENABLED_SERVICES` environment variable
3. `infra/docker/state/ops-agent/service-selection.json`
4. the built-in core defaults

When `OPENMAPX_ENABLED_SERVICES` is set, `enable` and `disable` refuse to edit
the file. Edit the environment selection instead, or unset it to resume file-based
selection.

The admin panel works on the same selection: **Save Selection** writes
`infra/docker/state/ops-agent/service-selection.json` too, and its Services page shows the
selection exactly as `services selected` does.

:::note[Selection is not the same as running]
Editing the selection does not stop or remove containers. To retire an optional
service, stop it while it is still in the rendered stack, disable its root, then
render. Check `services selected` afterward: a remaining dependency can select it
again. To stop the entire generated stack, use `pnpm openmapx compose down`; avoid
`--volumes` unless you intend to destroy named-volume data.
:::

### Presets

A **preset** is a named bundle of root services, so you can say "start the
routing stack" instead of listing every id. Presets work on `services start`,
`stop`, `restart`, `update`, and on `compose render` / `compose up`:

| Preset      | Services                                                      |
| ----------- | ------------------------------------------------------------- |
| `app`       | `app-api`, `app-web`, `well-known`                            |
| `proxy`     | `traefik`                                                     |
| `dev`       | `postgis`, `redis`                                            |
| `routing`   | `osrm`, `valhalla`                                            |
| `transit`   | `motis`, `motis-feed-proxy`, `otp`                            |
| `pelias`    | `pelias`, `pelias-pip`, `pelias-placeholder`, `elasticsearch` |
| `nominatim` | `nominatim`                                                   |
| `photon`    | `photon`                                                      |
| `overpass`  | `overpass`                                                    |
| `tiles`     | `tileserver`                                                  |
| `martin`    | `martin`                                                      |

Services outside a preset, including `data-manager`,
`ops-agent`, `local-ai`, `dawarich-app`, `dawarich-postgis`, `dawarich-redis`,
`dawarich-sidekiq`, `transitous-runner`, and `motis-staging`, are targeted
directly by service id.

Presets compose, and they mix freely with explicit ids:

```bash
pnpm openmapx services start --preset app,proxy,dev
pnpm openmapx services start postgis --preset routing
```

## Rendering the stack

OpenMapX has no hand-maintained compose file. The renderer reads the enabled
manifests and applies the stack:

```bash
pnpm openmapx compose render
```

Each render writes a **configuration generation** under
`infra/docker/state/ops-agent/configuration/generations/` and points
`infra/docker/state/ops-agent/configuration/current` at it. A generation holds:

- `docker-compose.generated.yml`: the compose file of the stack
- `docker-compose.generated.hardlinks.json`: the plan that maps each consumer
  to its data producer (applied later by `openmapx data link`)
- the selection it was rendered from, and the service settings and vault
  credentials saved in the admin panel

The admin panel's **Apply changes** writes the same kind of generation. A CLI render keeps what was
saved in the admin panel: it cannot read the database, so it takes those
settings and credentials from the current generation. Settings in `.env`
(`SERVICE_<ID>_<KEY>`) win over them in both.

The stack is addressed as Compose project `docker` with `infra/docker/.env` as
its environment. To run Compose by hand, name both:

```bash
docker compose --env-file infra/docker/.env \
  -f infra/docker/state/ops-agent/configuration/current/docker-compose.generated.yml ps
```

Rendering the same configuration produces the same stack content. Re-render any time the manifests, your
`.env`, the selection, or the registered community repos change. You can
override the selection or domain for a single render without touching the
persisted selection:

```bash
pnpm openmapx compose render --services app-api,app-web,well-known,data-manager,valhalla,photon
# --preset routing alone renders only that preset and its dependencies.
pnpm openmapx compose render --domain maps.example.com
```

`--domain` defaults to `DOMAIN` from `infra/docker/.env`. An explicit selection
alters the applied generation but not the desired selection file; the next normal
start/render returns to the persisted selection. Prefer `services enable` for
lasting changes. Presets on lifecycle commands target already-selected services;
they do not enable them.

## Starting, stopping, and restarting

`services start` is the everyday command: it renders the full enabled stack,
applies the hardlink plan, and then `docker compose up -d` for the services you
name. Always pass the ids (or a preset) you want to bring up.

```bash
pnpm openmapx services start postgis redis data-manager
pnpm openmapx services start --preset app,proxy
```

To boot the whole enabled stack at once instead, use `compose up`, which renders
and then starts everything in the selection:

```bash
pnpm openmapx compose up
```

The remaining lifecycle commands are thin wrappers around `docker compose` and
expect a rendered compose file to already exist:

```bash
pnpm openmapx services stop motis otp                  # docker compose stop
pnpm openmapx services restart app-api                 # in-place reboot (does NOT re-render)
pnpm openmapx services update valhalla                 # pull images + replace container
pnpm openmapx services status                          # container table (all services)
pnpm openmapx services status valhalla                 # one service
pnpm openmapx compose pull [ids...]                    # pull images without starting containers
pnpm openmapx compose release                          # update release pin against release manifest
pnpm openmapx compose rotate-redis-password --confirm-clients-stopped # rotate Redis ACL/secret
```

The distinction between `restart` and `start`/`update` matters:

- **`restart`** reboots the container in place. It does not re-render, so it
  won't pick up a changed manifest, `.env`, or selection; use it to bounce a
  service whose image and config are unchanged.
- **`start`** re-renders first, so it picks up compose-file changes.
- **`update`** re-renders, pulls the selected images, and force-recreates the
  target containers. An existing release overlay remains pinned. Select a newer
  application release with `compose release` first; see [Upgrading](./upgrading.md).
  Use `--no-deps` to replace only the named containers when dependencies are already
  healthy.
- **`compose rotate-redis-password`** rotates Redis credentials after clients
  (`app-api`, `data-manager`, and any extension clients) are stopped. Follow the
  [Redis rotation procedure](../guides/supporting-infrastructure.md#valkey--the-cache)
  for application and partial-failure recovery.

The PostGIS entrypoint forwards the first stop signal to PostgreSQL and waits
for it to exit, preserving its exit status. Docker allows the declared five-minute
shutdown grace before forcing termination. A stop during startup cancels readiness
or password synchronization without marking the database healthy. This container
grace is separate from the deadline of the service-management request.

For a single one-off check of the running containers across the stack:

```bash
pnpm openmapx check
```

You can also audit declared capabilities across installed service manifests:

```bash
pnpm openmapx services capabilities
pnpm openmapx services capabilities --unrecognised
```

For MOTIS upgrades, update ops-agent and data-manager together before resuming
promotion. Both must support confirmed primary and staging stops. If a stop or
recovery has an unknown outcome, inspect the containers and keep promotion
paused. See [MOTIS operations profiles](../administration/motis-operations-profiles.md)
for dataset recovery; a restart acknowledgement alone is not a health check.

### Lifecycle operation deadlines

Admin/API lifecycle operations run through the ops-agent with a finite budget for the
whole Docker Compose command: ten minutes for stack start and service start,
stop, restart, recreate, isolated recreate, and removal. This accommodates the
built-in PostGIS five-minute shutdown grace with room for startup work. The
broker allows another thirty seconds for settlement, and the API's result wait
adds five seconds to that broker deadline; async HTTP submission timeouts remain
unchanged. Host CLI lifecycle commands invoke Docker Compose directly and do
not inherit this broker deadline.

The ten-minute limit includes all stop/start work in a command, including
sequential dependency work. It does not grow with the number of services.
Longer custom shutdown graces, or a dependency chain whose aggregate work
exceeds ten minutes, are outside this guarantee and remain subject to the
bounded deadlines. The manifest duration syntax is unchanged.

Cancellation and deadline expiry terminate the Docker CLI process group, but
Docker may continue work in the daemon after the CLI exits. A timeout therefore
does not establish the final container state. Inspect the affected services
before deciding what to do next; do not automatically retry or repair the
operation.

## Viewing logs

```bash
pnpm openmapx services logs valhalla                   # last 100 lines
pnpm openmapx services logs valhalla --tail 500
pnpm openmapx services logs valhalla --follow          # stream
```

## Building prepared artifacts

A few engines can't boot from raw OSM data; they need a prepared graph or tile
set built first. Those services declare a build hook in their manifest; today
that's `osrm`, `otp`, `motis`, `pelias`, and `tileserver`. The build runs inside
a Dockerized helper, so you don't install `osmium` or friends on the host.

```bash
pnpm openmapx services build osrm tileserver --region europe/germany
```

`--region` picks the OSM extract to build against. After a successful build, the
CLI re-renders and re-applies hardlinks so the new artifacts are wired into the
stack. Use `--continue-on-error` (on `build`) or `--fail-fast` (on `build-all`)
to control behavior when one service's build fails.

`services build-all` builds every installed service declaring a build command,
including engines outside your selection. It currently plans OSRM, OTP, MOTIS,
Pelias, and TileServer GL in that order. Prefer explicit IDs for a small deployment.
Builds refuse running consumers; [Preparing data](./preparing-data.md#building-prepared-artifacts)
lists the consumers to stop. MOTIS operating-dataset updates use transactional
sync instead of the low-level build.

The source data those builds consume (OSM
extracts, GTFS feeds, map glyphs) is downloaded and refreshed separately. See
[Preparing data](./preparing-data.md) for the full data workflow, including the
one-command `data update` refresh that downloads, builds, renders, and links in
sequence.

## Configuring a service

Many services expose operator-tunable settings through a `configSchema` in their
manifest (Valhalla's elevation and admin-boundary toggles, for example). Values
resolve at render time through a three-layer cascade, highest priority first:

| Priority | Source               | Where it lives                              |
| :------: | -------------------- | ------------------------------------------- |
|    3     | Environment variable | `SERVICE_<ID>_<KEY>` in `infra/docker/.env` |
|    2     | Database             | the admin panel's per-service config form   |
|    1     | Schema default       | the manifest's `configSchema` default       |

Environment variables always win, which keeps Docker deployments predictable.
The env-var name is `SERVICE_` + the uppercased service id (hyphens become
underscores) + `_` + the uppercased config key:

```bash
# infra/docker/.env
SERVICE_VALHALLA_BUILD_ELEVATION=false
PHOTON_REGION=germany
```

Because the cascade runs at render time rather than container startup, a change
to `.env` or the admin config form takes effect only after you re-render and
apply the change to the affected service:

```bash
pnpm openmapx compose render
pnpm openmapx services update valhalla
```

The admin panel's **Save & Apply** reads the database configuration and vault,
writes a generation, and recreates the affected service. A host CLI render has
no direct database/vault access: it preserves values from the **last applied
generation** and overlays environment settings. Values saved in the database but
not yet applied are therefore unavailable to a fresh CLI render.

Apply newly saved admin settings before using the CLI to recreate their services.
After that apply, CLI renders preserve them. The API receives schema-backed
`SERVICE_*` overrides as environment references; after editing `.env`, use a host
CLI render/start to apply them and recreate `app-api` when its environment needs
updating. A container restart does not reload changed environment variables.

For example:

```bash
pnpm openmapx services start valhalla
# When API or data-manager environment changed:
pnpm openmapx services start app-api data-manager
```

:::note[Data-manager credentials are separate]
The transit pipelines run inside the `data-manager` container, which can't
see the integration host's config cascade. Authenticated catalog feeds use the Transitous API-key file mounted at
`/config/transitous/api-keys.json`. Other daemon settings must be explicitly
forwarded by `services/data-manager/service.json`; placing an arbitrary variable
in `.env` does not pass it to that container.
:::

## Exposure: what's reachable from outside

By default every service is reachable **only** on the private `openmapx` Docker
network; other containers reach it by service id (`http://valhalla:8002`,
`http://nominatim:8080`). Nothing is exposed to the host or the internet unless
its manifest opts in, in one of two ways:

- **Proxy routing** (`exposure.proxy`) generates file-provider routes for
  bundled Traefik, or Docker labels for an operator-run Traefik. Requests under your
  domain route to the container. TileServer GL, for example, is served at
  `https://${DOMAIN}/tiles/`.
- **Host port binding** (`exposure.hostPorts`) publishes a container port on
  the host. These default to binding `127.0.0.1` (loopback only), so a port is
  reachable from the host itself but not the public internet unless the manifest
  deliberately binds a non-loopback address.

Inspect exposure before starting a service. A community service requesting a
non-loopback host port is flagged as publicly accessible in the install preview.
Approved platform proxy routes and community host ports have different trust
boundaries; see the [service-manifest contract](../developer/service-manifest.md).

A loopback port that is already taken on the host can be moved from
`infra/docker/.env` with `<SERVICE>_HOST_PORT`, for example
`DATA_MANAGER_HOST_PORT=14000` or `POSTGIS_HOST_PORT=15432`. The CLI follows
`DATA_MANAGER_HOST_PORT` when it talks to the data-manager.

### Behind an existing reverse proxy

On a host where another Traefik already owns ports 80 and 443, OpenMapX can
route through it instead of starting its own. That Traefik must use the Docker
provider. Set its network, entrypoint and certificate resolver in
`infra/docker/.env`:

```bash
OPENMAPX_PROXY_NETWORK=proxy
OPENMAPX_PROXY_ENTRYPOINT=https
OPENMAPX_PROXY_CERT_RESOLVER=myresolver
```

The bundled `traefik` service is then never selected. Every routed service
(`app-web`, `app-api`, `well-known`, `tileserver`, …) joins the external
network, and its labels carry the entrypoint, resolver and network. Re-render
and start the stack as usual.

Copy `services/traefik/config/dynamic/middlewares.yml` into the external
Traefik's file-provider directory. The routes reference its middlewares with
`@file`, and Traefik disables a router whose middleware is missing. Without
`internal-deny@file`, requests to `/api/internal` fall through to the general
`/api` route and reach endpoints that are meant to be unreachable from outside.
The bundled Traefik also adds HSTS on its entrypoint. Behind your own proxy,
configure HSTS there, for example with the `hsts@file` middleware from the same
file.

Place, transit and road-condition ids travel encoded in the request path, for
example `/api/places/osm%3Anode%2F1`. Traefik 3.6.4 to 3.6.6 rejects encoded
slashes and similar characters with a 400 by default, so give the external
entrypoint the same `encodedCharacters` settings as the bundled
`services/traefik/config/traefik.yml`. Without them, opening a place or a
transit stop fails on those versions.

## Where to go next

- [Getting started](./getting-started.md): the first-deployment walkthrough
  that ties these commands together.
- [Preparing data](./preparing-data.md): downloading OSM, GTFS, and map glyphs,
  and the build/link pipeline.
- [Configuration](./configuration.md): `.env`, secrets, and the admin
  panel.
- [Upgrading](./upgrading.md): pulling new images and re-rendering safely.

## PostgreSQL workload diagnostics

API and data-manager connections carry the bounded static application names
`openmapx-api` and `openmapx-data-manager`. Inspect them in `pg_stat_activity`
without exposing connection URLs. Application names label clients;
`pg_stat_statements` aggregates statements by database, user and query identity,
not by application name. Attribute jobs with isolated replay windows or spans.

`POSTGIS_DIAGNOSTICS=false` and `POSTGIS_TRACK_IO_TIMING=false` are independent
container defaults. With both disabled the wrapper adds no diagnostic arguments.
On an initialized database, diagnostics opt-in resolves the effective
`shared_preload_libraries` with PostgreSQL's own configuration reader, preserves
its entries and adds `pg_stat_statements` once. Unresolvable or unusual quoted
preload syntax fails closed with a bounded message. Initialize the database with
diagnostics disabled first. Planning tracking stays off; I/O timing requires its
own opt-in and a separate overhead measurement.

These diagnostics are opt-in; the default deployment leaves them disabled. Before enabling either flag, verify a
backup and restore, accept the wrapper's graceful shutdown and the ops-agent stop
deadlines together, rehearse on disposable staging, and arrange a restart window.
Set the chosen flags as `POSTGIS_DIAGNOSTICS` / `POSTGIS_TRACK_IO_TIMING` in `.env`, render
and recreate the service in that window. A restart alone does not apply changed
container environment. A database operator then installs the extension with
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`. Verify the settings,
extension availability, health and an actual query before returning traffic.

Collect existing counters without resetting production statistics. Use
`pg_stat_statements(false)` and select only counters and identifiers; do not expose
query text or grant public statistics access. Measure I/O timing overhead against
the same disposable workload before enabling it. Rollback restores the previous
flag values through the same authority and uses another scheduled safe restart;
it preserves prior preload entries and saved evidence. No automatic activation,
production statistics reset or shutdown acceptance is implied by these options.

The [disposable replay protocol](../developer/self-hosting-replay.md) describes
source-level comparisons and their acceptance limits.

## Optional BRouter bicycle routing

BRouter is an opt-in service for cycling. Its segment downloads use an independent
region setting and need room for active and replacement generations. Follow
[Optional BRouter bicycle routing](../guides/routing-engines.md#optional-brouter-bicycle-routing)
for setup, tuning, update behavior, fallback limits, and attribution.
